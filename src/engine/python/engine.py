"""EEG Workbench engine.

Runs inside Pyodide in the browser (and in plain CPython for tests).
All session state lives here. The UI sends commands through ``handle`` and
receives a JSON description plus a list of flat numpy buffers.

Conventions
-----------
* Viewer windows are returned in SI units (volts for EEG).
* Analysis outputs (spectra, evoked responses, maps) are returned in microvolts.
* Times sent to the UI are seconds from the start of the *current* data.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import traceback
import zipfile

import numpy as np
import mne

mne.set_log_level("ERROR")

VERSION = "0.1.0"
GRID = 56  # scalp-map resolution (pixels per side)
BANDS = {
    "Delta": (1.0, 4.0),
    "Theta": (4.0, 8.0),
    "Alpha": (8.0, 13.0),
    "Beta": (13.0, 30.0),
    "Gamma": (30.0, 45.0),
}


# --------------------------------------------------------------------------- #
# Session
# --------------------------------------------------------------------------- #
class Session:
    def __init__(self):
        self.reset()

    def reset(self):
        self.name = None          # display name of the recording
        self.load_code = None     # python line(s) that load the data
        self.setup = {}           # channel types / renames / montage applied at load
        self.raw0 = None          # data as loaded (after setup)
        self.raw = None           # data after the pipeline
        self.steps = []           # pipeline: [{id, type, params, enabled}]
        self.applied = []         # keys of the steps applied to self.raw
        self.t_offset = 0.0       # seconds cropped from the start
        self.annots = []          # [{onset, duration, description}] in raw0 time
        self.ica = {}             # fit_key -> dict(ica, sources, psd, suggest)
        self.ica_key = None       # fit key of the ICA currently applied
        self.ckpt = None          # (keys, raw copy) taken just before an ICA step
        self.epochs = None
        self.epochs_cfg = None
        self.psd_cfg = None
        self.grid_cache = {}


S = Session()


class Out:
    """Collects arrays next to a JSON-serialisable description."""

    def __init__(self):
        self.buffers = []

    def arr(self, a, dtype="f4"):
        a = np.ascontiguousarray(np.asarray(a), dtype=dtype)
        self.buffers.append(a.ravel())
        return {"$buf": len(self.buffers) - 1, "shape": list(a.shape)}


def _jsonable(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


# --------------------------------------------------------------------------- #
# Loading and setup
# --------------------------------------------------------------------------- #
_STIM_NAMES = {"STATUS", "TRIGGER", "TRIG", "STIM", "STI 014", "STI014", "MARKER", "EVENT"}


def _clean_name(name):
    n = name.strip()
    for prefix in ("EEG ", "EEG-", "EEG_", "EEG"):
        if n.upper().startswith(prefix) and len(n) > len(prefix):
            n = n[len(prefix):]
            break
    n = n.strip(" .")
    for suffix in ("-REF", "-LE", "-AR", "-A1", "-A2", "-AVG", "-M1", "-M2", "_REF"):
        if n.upper().endswith(suffix):
            n = n[: -len(suffix)]
            break
    return n.strip(" .")


def _auto_setup(raw):
    """Guess channel types, tidy channel names and attach a standard montage."""
    setup = {"types": {}, "rename": {}, "montage": None}
    types_now = raw.get_channel_types()

    for ch, tp in zip(raw.ch_names, types_now):
        if tp != "eeg":
            continue
        u = ch.upper()
        if "EOG" in u:
            setup["types"][ch] = "eog"
        elif "ECG" in u or "EKG" in u:
            setup["types"][ch] = "ecg"
        elif "EMG" in u:
            setup["types"][ch] = "emg"
        elif u.strip() in _STIM_NAMES:
            setup["types"][ch] = "stim"
        elif any(k in u for k in ("RESP", "TEMP", "GSR", "SPO2", "PLETH", "ACC", "PHOTIC", "PULSE")):
            setup["types"][ch] = "misc"
    if setup["types"]:
        raw.set_channel_types(setup["types"])

    eeg = [raw.ch_names[i] for i in mne.pick_types(raw.info, eeg=True, exclude=[])]
    has_pos = [
        ch for ch in eeg
        if np.isfinite(raw.info["chs"][raw.ch_names.index(ch)]["loc"][:3]).all()
        and np.any(raw.info["chs"][raw.ch_names.index(ch)]["loc"][:3] != 0)
    ]
    if eeg and len(has_pos) < 0.5 * len(eeg):
        montage = mne.channels.make_standard_montage("standard_1005")
        lookup = {n.lower(): n for n in montage.ch_names}
        rename, taken = {}, set(raw.ch_names)
        for ch in eeg:
            std = lookup.get(_clean_name(ch).lower())
            if std and std != ch and std not in taken:
                rename[ch] = std
                taken.add(std)
        matched = sum(1 for ch in eeg if rename.get(ch, ch).lower() in lookup)
        if matched >= 3:
            if rename:
                raw.rename_channels(rename)
                setup["rename"] = rename
                setup["types"] = {rename.get(k, k): v for k, v in setup["types"].items()}
            raw.set_montage(montage, match_case=False, on_missing="ignore")
            setup["montage"] = "standard_1005"
    return setup


def _extract_annotations(raw):
    """Move file annotations and stim-channel events into the session list."""
    annots = []
    ann = raw.annotations
    shift = raw.first_time if ann.orig_time is not None else 0.0
    for onset, duration, desc in zip(ann.onset, ann.duration, ann.description):
        annots.append({"onset": float(onset - shift), "duration": float(duration), "description": str(desc)})
    if not annots and len(mne.pick_types(raw.info, stim=True)):
        try:
            events = mne.find_events(raw, shortest_event=1)
            for samp, _, code in events:
                annots.append({
                    "onset": float((samp - raw.first_samp) / raw.info["sfreq"]),
                    "duration": 0.0,
                    "description": str(int(code)),
                })
        except Exception:
            pass
    raw.set_annotations(None)
    return sorted(annots, key=lambda a: a["onset"])


def _start(raw, name, load_code):
    S.reset()
    S.name = name
    S.load_code = load_code
    S.setup = _auto_setup(raw)
    S.annots = _extract_annotations(raw)
    S.raw0 = raw
    S.typical_uv = _typical_amplitude(raw)
    _recompute(force=True)


def _typical_amplitude(raw):
    """Robust spread of the EEG channels in microvolts, used to pick a sensible display scale."""
    picks = mne.pick_types(raw.info, eeg=True, exclude=[])
    if not len(picks):
        return 50.0
    sf = raw.info["sfreq"]
    stop = int(min(raw.n_times, 60 * sf))
    x = raw.get_data(picks=picks, stop=stop)[:, :: max(1, int(sf // 50))]
    x = x - np.median(x, axis=1, keepdims=True)
    q75, q25 = np.percentile(x, [75, 25], axis=1)
    return float(np.median(q75 - q25) / 1.349 * 1e6)


MONTAGES = [
    "standard_1005", "standard_1020", "biosemi16", "biosemi32", "biosemi64", "biosemi128", "biosemi256",
    "GSN-HydroCel-32", "GSN-HydroCel-64_1.0", "GSN-HydroCel-128", "GSN-HydroCel-256", "easycap-M1", "easycap-M10",
]


def cmd_setup(a, out):
    """Change channel types and/or the electrode layout, then replay the pipeline."""
    raw = S.raw0
    types = {k: v for k, v in (a.get("types") or {}).items() if k in raw.ch_names}
    if types:
        raw.set_channel_types(types)
        S.setup.setdefault("types", {}).update(types)
    montage = a.get("montage")
    if montage:
        if montage not in MONTAGES:
            raise ValueError(f"Unknown electrode layout: {montage}")
        raw.set_montage(montage, match_case=False, on_missing="ignore")
        S.setup["montage"] = montage
    S.ica, S.ica_key, S.ckpt, S.grid_cache, S.applied = {}, None, None, {}, []
    S.typical_uv = _typical_amplitude(raw)
    _recompute(force=True)
    return cmd_info({}, out)


def cmd_load(a, out):
    path = a["path"]
    ext = os.path.splitext(path)[1].lower()
    kwargs = {"infer_types": True} if ext in (".edf", ".bdf") else {}
    try:
        raw = mne.io.read_raw(path, preload=True, **kwargs)
    except TypeError:
        raw = mne.io.read_raw(path, preload=True)
    fname = os.path.basename(path)
    code = f'raw = mne.io.read_raw("{fname}", preload=True{", infer_types=True" if kwargs else ""})'
    _start(raw, fname, code)
    return cmd_info({}, out)


# --------------------------------------------------------------------------- #
# Demo recording (synthetic)
# --------------------------------------------------------------------------- #
DEMO_CHANNELS = [
    "Fp1", "Fp2", "AF3", "AF4", "F7", "F3", "Fz", "F4", "F8", "FC5", "FC1", "FC2", "FC6",
    "T7", "C3", "Cz", "C4", "T8", "CP5", "CP1", "CP2", "CP6", "P7", "P3", "Pz", "P4", "P8",
    "PO3", "PO4", "O1", "Oz", "O2",
]


def make_demo(seed=7, duration=240.0, sfreq=250.0):
    """Simulated oddball recording with realistic artifacts.

    Contains: 1/f background activity, posterior alpha, eye blinks, temporal
    muscle bursts, 50 Hz line noise, slow drift, one noisy channel, and
    "standard"/"target" events whose targets evoke a parietal P300.
    """
    rng = np.random.default_rng(seed)
    n = int(sfreq * duration)
    t = np.arange(n) / sfreq
    montage = mne.channels.make_standard_montage("standard_1020")
    allpos = montage.get_positions()["ch_pos"]
    pos = np.array([allpos[c] for c in DEMO_CHANNELS])
    unit = pos / np.linalg.norm(pos, axis=1, keepdims=True)

    def pattern(center, width):
        c = np.asarray(center, float)
        c = c / np.linalg.norm(c)
        ang = np.arccos(np.clip(unit @ c, -1, 1))
        return np.exp(-(ang / width) ** 2)

    def at(name):
        return unit[DEMO_CHANNELS.index(name)]

    def pink(size):
        f = np.fft.rfftfreq(size, 1 / sfreq)
        spec = rng.standard_normal(f.size) + 1j * rng.standard_normal(f.size)
        spec[1:] /= np.sqrt(f[1:])
        spec[0] = 0
        x = np.fft.irfft(spec, size)
        return x / x.std()

    def smooth(x, seconds):
        k = max(1, int(seconds * sfreq))
        return np.convolve(x, np.hanning(k) / np.hanning(k).sum(), mode="same")

    data = np.zeros((len(DEMO_CHANNELS), n))

    # background: spatially smooth 1/f sources + sensor noise
    for _ in range(18):
        centre = rng.standard_normal(3)
        centre[2] = abs(centre[2]) + 0.2
        data += np.outer(pattern(centre, 0.55) * rng.choice([-1, 1]), pink(n)) * 3.2e-6
    data += rng.standard_normal(data.shape) * 0.8e-6

    # posterior alpha with a slowly varying envelope
    env = np.abs(smooth(rng.standard_normal(n), 2.5))
    env = env / env.max()
    phase = 2 * np.pi * np.cumsum(10.0 + 0.4 * smooth(rng.standard_normal(n), 1.0) * 20) / sfreq
    data += np.outer(pattern(at("Oz"), 0.65), np.sin(phase) * env) * 14e-6

    # eye blinks
    blink_pat = pattern((at("Fp1") + at("Fp2")) / 2 + np.array([0, 0.25, -0.25]), 0.6)
    blink = np.zeros(n)
    tb = 2.0
    while tb < duration - 1:
        w = int(rng.uniform(0.28, 0.42) * sfreq)
        i0 = int(tb * sfreq)
        blink[i0:i0 + w] += np.hanning(w)[: max(0, min(w, n - i0))] * rng.uniform(0.8, 1.2)
        tb += rng.uniform(2.5, 6.0)
    data += np.outer(blink_pat, blink) * 130e-6

    # temporal muscle bursts
    for side in ("T7", "T8"):
        burst = np.zeros(n)
        tm = rng.uniform(8, 25)
        while tm < duration - 3:
            i0, w = int(tm * sfreq), int(rng.uniform(0.8, 2.0) * sfreq)
            burst[i0:i0 + w] = np.hanning(w)
            tm += rng.uniform(22, 40)
        hf = np.diff(rng.standard_normal(n + 1))
        data += np.outer(pattern(at(side), 0.42), hf * burst) * 14e-6

    # line noise, drift, one noisy channel
    data += np.outer(rng.uniform(0.5, 1.6, len(DEMO_CHANNELS)), np.sin(2 * np.pi * 50 * t)) * 2.6e-6
    for i in range(len(DEMO_CHANNELS)):
        drift = smooth(np.cumsum(rng.standard_normal(n)), 6.0)
        data[i] += drift / (np.abs(drift).max() + 1e-12) * rng.uniform(15, 45) * 1e-6
    data[DEMO_CHANNELS.index("P7")] += rng.standard_normal(n) * 55e-6

    # oddball events and evoked responses
    def bump(latency, sd, length=0.9):
        tt = np.arange(int(length * sfreq)) / sfreq
        return np.exp(-0.5 * ((tt - latency) / sd) ** 2)

    n1, p2, p3 = bump(0.10, 0.022), bump(0.185, 0.032), bump(0.38, 0.075)
    central, parietal = pattern(at("Cz"), 0.6), pattern(at("Pz"), 0.6)
    onsets, labels = [], []
    te, last_target = 3.0, False
    while te < duration - 1.5:
        is_target = (not last_target) and rng.random() < 0.25
        onsets.append(te)
        labels.append("target" if is_target else "standard")
        i0, L = int(te * sfreq), n1.size
        g = rng.uniform(0.7, 1.3)
        data[:, i0:i0 + L] += np.outer(central, (-3.2e-6 * n1 + 4.0e-6 * p2) * g)
        if is_target:
            data[:, i0:i0 + L] += np.outer(parietal, 9.5e-6 * p3 * rng.uniform(0.7, 1.3))
        last_target = is_target
        te += rng.uniform(1.0, 1.4)

    info = mne.create_info(DEMO_CHANNELS, sfreq, "eeg")
    raw = mne.io.RawArray(data, info)
    raw.set_montage(montage)
    raw.set_annotations(mne.Annotations(onsets, [0.0] * len(onsets), labels))
    return raw


def cmd_demo(a, out):
    raw = make_demo()
    code = (
        'raw = mne.io.read_raw_fif("eeg_workbench_demo_raw.fif", preload=True)'
        "  # export the demo recording from Lab first"
    )
    _start(raw, "Demo recording (simulated oddball task)", code)
    return cmd_info({}, out)


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def _eeg_picks(raw, exclude="bads"):
    return mne.pick_types(raw.info, eeg=True, exclude=exclude)


def _key(prev, step):
    payload = json.dumps([step["type"], step["params"]], sort_keys=True, default=_jsonable)
    return hashlib.sha1((prev + payload).encode()).hexdigest()


def _ica_fit_key(prev, params):
    fit = {k: params.get(k) for k in ("n_components", "method", "seed")}
    return hashlib.sha1((prev + json.dumps(fit, sort_keys=True)).encode()).hexdigest()


def _notch_freqs(raw, p):
    nyq = raw.info["sfreq"] / 2.0
    base = float(p["freq"])
    n = 8 if p.get("harmonics", True) else 1
    return [base * k for k in range(1, n + 1) if base * k < nyq - 1]


def _fit_ica(raw, p, fit_key):
    picks = _eeg_picks(raw)
    n_comp = int(min(p.get("n_components", 15), max(2, len(picks) - 1)))
    fit_raw = raw
    if (raw.info["highpass"] or 0) < 1.0:
        fit_raw = raw.copy().filter(1.0, None, picks=picks)
    decim = max(1, int(round(raw.info["sfreq"] / 125.0)))
    ica = mne.preprocessing.ICA(
        n_components=n_comp, method=p.get("method", "picard"),
        random_state=int(p.get("seed", 97)), max_iter=500,
    )
    ica.fit(fit_raw, picks=picks, decim=decim, reject_by_annotation=True)

    sources = ica.get_sources(fit_raw).get_data()
    sf = raw.info["sfreq"]
    from scipy.signal import welch
    freqs, psd = welch(sources, fs=sf, nperseg=int(min(sources.shape[1], sf * 2)))
    keep = freqs <= min(60.0, sf / 2)

    suggest = {}
    names = [raw.ch_names[i] for i in picks]
    frontal = [c for c in names if c.lower() in ("fp1", "fp2", "fpz", "af7", "af8", "af3", "af4")][:2]
    eog_chs = [raw.ch_names[i] for i in mne.pick_types(raw.info, eog=True)]
    try:
        if eog_chs or frontal:
            idx, _ = ica.find_bads_eog(fit_raw, ch_name=(eog_chs or frontal))
            for i in idx:
                suggest[int(i)] = "eye"
    except Exception:
        pass
    # muscle: spectrum that stays flat or rises from 7 to 45 Hz instead of falling
    band = (freqs >= 7) & (freqs <= min(45.0, sf / 2 - 1))
    if band.sum() >= 5:
        slopes = np.polyfit(np.log(freqs[band]), np.log(psd[:, band].T + 1e-30), 1)[0]
        for i in np.where(slopes > -0.5)[0]:
            suggest.setdefault(int(i), "muscle")
    try:
        if len(mne.pick_types(raw.info, ecg=True)):
            idx, _ = ica.find_bads_ecg(fit_raw)
            for i in idx:
                suggest.setdefault(int(i), "heart")
    except Exception:
        pass

    mixing = ica.get_components()  # (n_channels, n_components)
    power = sources.var(axis=1) * (mixing ** 2).sum(axis=0)
    S.ica = {fit_key: {  # keep only the most recent fit to bound memory
        "ica": ica,
        "names": names,
        "sources": sources.astype("f4"),
        "sfreq": sf,
        "freqs": freqs[keep],
        "psd": psd[:, keep],
        "var": power / power.sum(),
        "suggest": suggest,
        "t_offset": S.t_offset,
    }}
    return S.ica[fit_key]


def _apply_step(raw, step, prev_key):
    t, p = step["type"], step["params"]
    if t == "filter":
        raw.filter(p.get("l_freq"), p.get("h_freq"))
    elif t == "notch":
        freqs = _notch_freqs(raw, p)
        if freqs:
            raw.notch_filter(freqs)
    elif t == "resample":
        raw.resample(float(p["sfreq"]))
    elif t == "reference":
        if p.get("kind", "average") == "average":
            raw.set_eeg_reference("average", projection=False)
        else:
            raw.set_eeg_reference(ref_channels=list(p["channels"]))
    elif t == "crop":
        tmax = p.get("tmax")
        tmin = float(p.get("tmin") or 0.0)
        raw.crop(tmin, None if tmax is None else min(float(tmax), raw.times[-1]))
        S.t_offset += tmin
    elif t == "bads":
        raw.info["bads"] = [c for c in p["channels"] if c in raw.ch_names]
    elif t == "interpolate":
        if raw.info["bads"]:
            raw.interpolate_bads(reset_bads=True)
    elif t == "drop":
        raw.drop_channels([c for c in p["channels"] if c in raw.ch_names])
    elif t == "ica":
        fit_key = _ica_fit_key(prev_key, p)
        entry = S.ica.get(fit_key) or _fit_ica(raw, p, fit_key)
        S.ica_key = fit_key
        ica = entry["ica"]
        ica.exclude = [int(i) for i in p.get("exclude", []) if int(i) < ica.n_components_]
        if ica.exclude:
            ica.apply(raw)
    else:
        raise ValueError(f"Unknown step type: {t}")


def _sync_annotations():
    raw = S.raw
    dur = raw.times[-1]
    keep = [a for a in S.annots if -1e-9 <= a["onset"] - S.t_offset <= dur]
    raw.set_annotations(mne.Annotations(
        [a["onset"] - S.t_offset for a in keep],
        [a["duration"] for a in keep],
        [a["description"] for a in keep],
    ))


def _recompute(force=False):
    steps = [s for s in S.steps if s.get("enabled", True)]
    keys, prev = [], "root"
    for s in steps:
        prev = _key(prev, s)
        keys.append(prev)

    start = 0
    if not force and S.raw is not None and keys[: len(S.applied)] == S.applied:
        start = len(S.applied)                      # pure append: continue in place
    elif S.ckpt is not None and keys[: len(S.ckpt[0])] == S.ckpt[0]:
        S.raw = S.ckpt[1].copy()                    # resume from the checkpoint
        S.t_offset = S.ckpt[2]
        start = len(S.ckpt[0])
    else:
        S.raw = S.raw0.copy()
        S.t_offset = 0.0
        S.ckpt = None

    if not any(s["type"] == "ica" for s in steps):
        S.ica_key = None
    small = S.raw0._data.nbytes < 200e6
    for i in range(start, len(steps)):
        if steps[i]["type"] == "ica" and small and (S.ckpt is None or S.ckpt[0] != keys[:i]):
            S.ckpt = (keys[:i], S.raw.copy(), S.t_offset)
        _apply_step(S.raw, steps[i], keys[i - 1] if i else "root")
    S.applied = keys
    S.epochs = None
    _sync_annotations()


def cmd_set_steps(a, out):
    old = S.steps
    S.steps = a["steps"]
    try:
        _recompute()
    except Exception:
        S.steps = old
        _recompute(force=True)
        raise
    return cmd_info({}, out)


# --------------------------------------------------------------------------- #
# Info, viewer data
# --------------------------------------------------------------------------- #
def _pos2d(info, picks):
    """2-D scalp positions on a unit head circle (x right, y towards the nose)."""
    try:
        from mne.channels.layout import _find_topomap_coords
        xy = _find_topomap_coords(info, picks, sphere=np.array([0.0, 0.0, 0.0, 0.095]))
        return np.asarray(xy) / 0.095
    except Exception:
        loc = np.array([info["chs"][i]["loc"][:3] for i in picks], float)
        u = loc / (np.linalg.norm(loc, axis=1, keepdims=True) + 1e-12)
        theta = np.arccos(np.clip(u[:, 2], -1, 1)) / (np.pi / 2)
        planar = np.linalg.norm(u[:, :2], axis=1) + 1e-12
        return np.c_[theta * u[:, 0] / planar, theta * u[:, 1] / planar]


def _has_pos(info, i):
    loc = info["chs"][i]["loc"][:3]
    return bool(np.isfinite(loc).all() and np.any(loc != 0))


def cmd_info(a, out):
    raw = S.raw
    if raw is None:
        return {"loaded": False}
    types = raw.get_channel_types()
    info = raw.info
    eeg_all = _eeg_picks(raw, exclude=[])
    with_pos = [i for i in eeg_all if _has_pos(info, i)]
    pos = {}
    if len(with_pos) >= 3:
        xy = _pos2d(info, with_pos)
        pos = {raw.ch_names[i]: [float(xy[k, 0]), float(xy[k, 1])] for k, i in enumerate(with_pos)}
    ann = raw.annotations
    counts = {}
    for d in ann.description:
        counts[str(d)] = counts.get(str(d), 0) + 1
    ica = None
    if S.ica_key and S.ica_key in S.ica:
        e = S.ica[S.ica_key]
        ica = {"n": int(e["ica"].n_components_), "exclude": [int(i) for i in e["ica"].exclude]}
    return {
        "loaded": True,
        "name": S.name,
        "sfreq": float(info["sfreq"]),
        "n_times": int(raw.n_times),
        "duration": float(raw.n_times / info["sfreq"]),
        "highpass": float(info["highpass"] or 0),
        "lowpass": float(info["lowpass"] or 0),
        "channels": [
            {"name": n, "type": t, "bad": n in info["bads"], "pos": pos.get(n)}
            for n, t in zip(raw.ch_names, types)
        ],
        "annotations": [
            {"onset": float(o), "duration": float(d), "description": str(s)}
            for o, d, s in zip(ann.onset, ann.duration, ann.description)
        ],
        "event_counts": counts,
        "montage": S.setup.get("montage"),
        "montages": MONTAGES,
        "typical_uv": getattr(S, "typical_uv", 50.0),
        "memory_mb": round(S.raw0._data.nbytes / 1e6, 1),
        "ica": ica,
        "steps": S.steps,
    }


def _minmax(x, px):
    n = x.shape[1]
    if n <= 2 * px:
        return x, False
    k = int(np.ceil(n / px))                 # samples per column
    cols = int(np.ceil(n / k))
    pad = cols * k - n
    if pad:                                  # cover every sample: pad the last column
        x = np.concatenate([x, np.repeat(x[:, -1:], pad, axis=1)], axis=1)
    x = x.reshape(x.shape[0], cols, k)
    o = np.empty((x.shape[0], 2 * cols), "f4")
    o[:, 0::2] = x.min(axis=2)
    o[:, 1::2] = x.max(axis=2)
    return o, True


def cmd_window(a, out):
    """Decimated traces for the viewer. mode: "data" | "ica"."""
    raw = S.raw
    sf = raw.info["sfreq"]
    t0 = max(0.0, float(a["t0"]))
    t1 = min(raw.n_times / sf, float(a["t1"]))
    px = int(a.get("px", 1200))
    i0, i1 = int(t0 * sf), max(int(t0 * sf) + 2, int(t1 * sf))
    res = {"t0": i0 / sf, "t1": i1 / sf}

    if a.get("mode") == "ica" and S.ica_key in S.ica:
        e = S.ica[S.ica_key]
        shift = S.t_offset - e["t_offset"]
        j0, j1 = int((t0 + shift) * e["sfreq"]), int((t1 + shift) * e["sfreq"])
        x, dec = _minmax(e["sources"][:, max(0, j0):max(j0 + 2, j1)], px)
        res.update(data=out.arr(x), minmax=dec)
        return res

    x, dec = _minmax(raw.get_data(start=i0, stop=i1), px)
    res.update(data=out.arr(x), minmax=dec)
    if a.get("compare"):
        r0 = S.raw0
        sf0 = r0.info["sfreq"]
        j0, j1 = int((t0 + S.t_offset) * sf0), int((t1 + S.t_offset) * sf0)
        names = [n for n in raw.ch_names if n in r0.ch_names]
        y, dec0 = _minmax(r0.get_data(picks=names, start=j0, stop=max(j0 + 2, j1)), px)
        res.update(compare=out.arr(y), compare_minmax=dec0, compare_names=names)
    return res


def cmd_overview(a, out):
    raw = S.raw
    picks = _eeg_picks(raw)
    if not len(picks):
        picks = np.arange(len(raw.ch_names))
    bins = int(a.get("bins", 600))
    step = max(1, raw.n_times // (bins * 8))
    x = raw.get_data(picks=picks)[:, ::step]
    x = x - np.median(x, axis=1, keepdims=True)
    g = x.std(axis=0)
    k = max(1, g.size // bins)
    g = g[: (g.size // k) * k].reshape(-1, k).max(axis=1)
    return {"env": out.arr(g)}


# --------------------------------------------------------------------------- #
# Annotations and bad channels
# --------------------------------------------------------------------------- #
def cmd_annotate(a, out):
    if a["op"] == "add":
        S.annots.append({
            "onset": float(a["onset"]) + S.t_offset,
            "duration": float(a.get("duration", 0.0)),
            "description": str(a["description"]),
        })
        S.annots.sort(key=lambda x: x["onset"])
    elif a["op"] == "remove":
        on = float(a["onset"]) + S.t_offset
        S.annots = [
            x for x in S.annots
            if not (abs(x["onset"] - on) < 1e-6 and x["description"] == a["description"])
        ]
    _sync_annotations()
    S.epochs = None
    return cmd_info({}, out)


def cmd_detect_bads(a, out):
    """Flag flat, noisy and poorly correlated EEG channels."""
    raw = S.raw
    picks = _eeg_picks(raw, exclude=[])
    names = [raw.ch_names[i] for i in picks]
    sf = raw.info["sfreq"]
    step = max(1, int(sf // 100))
    x = raw.get_data(picks=picks)[:, ::step]
    x = x - np.median(x, axis=1, keepdims=True)
    q75, q25 = np.percentile(x, [75, 25], axis=1)
    spread = (q75 - q25) / 1.349
    med = np.median(spread)
    mad = np.median(np.abs(spread - med)) * 1.4826 + 1e-15
    z = (spread - med) / mad

    hf = np.diff(x, axis=1)
    hq75, hq25 = np.percentile(hf, [75, 25], axis=1)
    hspread = (hq75 - hq25) / 1.349
    hz = (hspread - np.median(hspread)) / (np.median(np.abs(hspread - np.median(hspread))) * 1.4826 + 1e-15)

    from scipy.signal import butter, sosfiltfilt
    fs = sf / step
    sos = butter(2, [1.0, min(30.0, fs / 2 - 1)], btype="band", fs=fs, output="sos")
    corr = np.corrcoef(sosfiltfilt(sos, x, axis=1))
    np.fill_diagonal(corr, np.nan)
    best = np.nanpercentile(np.abs(corr), 90, axis=1)

    found = []
    for i, n in enumerate(names):
        if spread[i] < 1e-8 or spread[i] < 0.05 * med:
            found.append({"name": n, "reason": "flat signal", "score": float(spread[i] * 1e6)})
        elif z[i] > 5 or hz[i] > 6:
            found.append({"name": n, "reason": "unusually noisy", "score": float(max(z[i], hz[i]))})
        elif len(names) > 4 and best[i] < 0.1:
            found.append({"name": n, "reason": "does not follow its neighbours", "score": float(best[i])})
    return {"bads": found}


# --------------------------------------------------------------------------- #
# Scalp maps
# --------------------------------------------------------------------------- #
def _grid_maps(names, values):
    """Interpolate channel values (n_maps, n_ch) to (n_maps, GRID, GRID) inside the head."""
    values = np.atleast_2d(np.asarray(values, float))
    key = tuple(names)
    cached = S.grid_cache.get(key)
    if cached is None:
        from scipy.interpolate import RBFInterpolator
        info = S.raw.info
        idx = [S.raw.ch_names.index(n) for n in names]
        xy = _pos2d(info, idx)
        lin = np.linspace(-1.12, 1.12, GRID)
        gx, gy = np.meshgrid(lin, lin[::-1])
        inside = (gx ** 2 + gy ** 2) <= 1.0
        pts = np.c_[gx[inside], gy[inside]]
        # weights: interpolate the identity so new maps are a matrix product
        W = RBFInterpolator(xy, np.eye(len(names)), kernel="thin_plate_spline", smoothing=1e-4)(pts)
        cached = (inside, W)
        S.grid_cache = {key: cached}
    inside, W = cached
    grids = np.full((values.shape[0], GRID, GRID), np.nan, "f4")
    grids[:, inside] = (values @ W.T).astype("f4")
    return grids


def _map_names(names):
    info = S.raw.info
    return [n for n in names if _has_pos(info, S.raw.ch_names.index(n))]


# --------------------------------------------------------------------------- #
# Spectrum
# --------------------------------------------------------------------------- #
def cmd_psd(a, out):
    raw = S.raw
    picks = _eeg_picks(raw)
    if not len(picks):
        raise ValueError("No good EEG channels to analyse.")
    sf = raw.info["sfreq"]
    fmin = float(a.get("fmin", 0.5))
    fmax = float(min(a.get("fmax", 45.0), sf / 2 - 0.5))
    win = float(a.get("window", 2.0))
    n_fft = int(min(raw.n_times, win * sf))
    spec = raw.compute_psd(
        method="welch", fmin=fmin, fmax=fmax, n_fft=n_fft, n_overlap=n_fft // 2,
        picks=picks, reject_by_annotation=True,
    )
    psd = spec.get_data() * 1e12  # µV²/Hz
    freqs = spec.freqs
    names = [raw.ch_names[i] for i in picks]
    S.psd_cfg = {"fmin": fmin, "fmax": fmax, "window": win}

    total_band = (freqs >= 1.0) & (freqs <= min(45.0, fmax))
    total = np.trapezoid(psd[:, total_band], freqs[total_band], axis=1) + 1e-30
    bands, absolute, relative = [], [], []
    for name, (lo, hi) in BANDS.items():
        m = (freqs >= lo) & (freqs <= hi)
        if m.sum() < 2:
            continue
        p = np.trapezoid(psd[:, m], freqs[m], axis=1)
        bands.append({"name": name, "lo": lo, "hi": hi})
        absolute.append(p)
        relative.append(p / total)
    absolute, relative = np.array(absolute), np.array(relative)

    res = {
        "names": names,
        "freqs": out.arr(freqs),
        "psd": out.arr(psd),
        "bands": bands,
        "abs": out.arr(absolute),
        "rel": out.arr(relative),
    }
    mnames = _map_names(names)
    if len(mnames) >= 4 and len(bands):
        sel = [names.index(n) for n in mnames]
        res["maps"] = out.arr(_grid_maps(mnames, relative[:, sel]))
        res["map_names"] = mnames

    # peak alpha frequency over posterior channels (centre of gravity, 7–13 Hz)
    post = [i for i, n in enumerate(names) if n.upper().startswith(("O", "PO", "P"))] or list(range(len(names)))
    m = (freqs >= 7) & (freqs <= 13)
    if m.sum() >= 3:
        mean = psd[post][:, m].mean(axis=0)
        res["peak_alpha"] = float((freqs[m] * mean).sum() / mean.sum())

    def has(*chs):
        return all(c in names for c in chs)

    extras = {}
    if has("F3", "F4") and len(bands) > 2:
        al = [b["name"] for b in bands].index("Alpha")
        extras["frontal_alpha_asymmetry"] = float(
            np.log(absolute[al, names.index("F4")]) - np.log(absolute[al, names.index("F3")])
        )
    bn = [b["name"] for b in bands]
    if "Theta" in bn and "Beta" in bn:
        extras["theta_beta_ratio"] = float(absolute[bn.index("Theta")].mean() / absolute[bn.index("Beta")].mean())
    if "Alpha" in bn and "Theta" in bn:
        extras["alpha_theta_ratio"] = float(absolute[bn.index("Alpha")].mean() / absolute[bn.index("Theta")].mean())
    res["metrics"] = extras
    return res


# --------------------------------------------------------------------------- #
# ICA review
# --------------------------------------------------------------------------- #
def cmd_ica_info(a, out):
    if not S.ica_key or S.ica_key not in S.ica:
        return {"fitted": False}
    e = S.ica[S.ica_key]
    ica = e["ica"]
    mixing = ica.get_components()
    names = e["names"]
    mnames = [n for n in names if n in S.raw.ch_names and _has_pos(S.raw.info, S.raw.ch_names.index(n))]
    res = {
        "fitted": True,
        "n": int(ica.n_components_),
        "exclude": [int(i) for i in ica.exclude],
        "suggest": {str(k): v for k, v in e["suggest"].items()},
        "var": out.arr(e["var"]),
        "freqs": out.arr(e["freqs"]),
        "psd": out.arr(e["psd"]),
        "duration": float(e["sources"].shape[1] / e["sfreq"]),
    }
    if len(mnames) >= 4:
        sel = [names.index(n) for n in mnames]
        m = mixing[sel].T
        m = m / (np.abs(m).max(axis=1, keepdims=True) + 1e-30)
        res["maps"] = out.arr(_grid_maps(mnames, m))
    return res


# --------------------------------------------------------------------------- #
# Epochs and evoked responses
# --------------------------------------------------------------------------- #
def cmd_epochs(a, out):
    raw = S.raw
    conds = list(a["conditions"])
    if not conds:
        raise ValueError("Choose at least one event type.")
    event_id = {c: i + 1 for i, c in enumerate(conds)}
    events, _ = mne.events_from_annotations(raw, event_id=event_id)
    if not len(events):
        raise ValueError("None of the chosen events are in the recording.")
    tmin, tmax = float(a.get("tmin", -0.2)), float(a.get("tmax", 0.8))
    base = a.get("baseline")
    baseline = None if base is None else (base[0], base[1])
    reject_uv = a.get("reject_uv")
    reject = {"eeg": float(reject_uv) * 1e-6} if reject_uv else None
    epochs = mne.Epochs(
        raw, events, event_id=event_id, tmin=tmin, tmax=tmax, baseline=baseline,
        reject=reject, picks=_eeg_picks(raw), preload=True, reject_by_annotation=True,
    )
    S.epochs = epochs
    S.epochs_cfg = {"conditions": conds, "tmin": tmin, "tmax": tmax, "baseline": base, "reject_uv": reject_uv}

    names = epochs.ch_names
    kept, evoked = {}, []
    found = {c: int((events[:, 2] == i).sum()) for c, i in event_id.items()}
    for c in conds:
        n = len(epochs[c]) if c in epochs.event_id else 0
        kept[c] = n
        if n:
            evoked.append(epochs[c].average().data * 1e6)
        else:
            evoked.append(np.zeros((len(names), len(epochs.times))))
    evoked = np.array(evoked)
    return {
        "conditions": conds,
        "names": names,
        "times": out.arr(epochs.times),
        "evoked": out.arr(evoked),
        "gfp": out.arr(evoked.std(axis=1)),
        "kept": kept,
        "found": found,
        "has_maps": len(_map_names(names)) >= 4,
    }


def _evoked_data(spec):
    """spec: a condition name or "A - B"."""
    ep = S.epochs
    if " - " in spec:
        x, y = [s.strip() for s in spec.split(" - ", 1)]
        return ep[x].average().data - ep[y].average().data
    return ep[spec].average().data


def cmd_evoked_maps(a, out):
    ep = S.epochs
    if ep is None:
        raise ValueError("Create epochs first.")
    data = _evoked_data(a["condition"]) * 1e6
    names = ep.ch_names
    mnames = _map_names(names)
    sel = [names.index(n) for n in mnames]
    half = float(a.get("avg", 0.01))
    vals = []
    for t in a["times"]:
        m = (ep.times >= t - half) & (ep.times <= t + half)
        if not m.any():
            m = np.zeros(ep.times.size, bool)
            m[np.abs(ep.times - t).argmin()] = True
        vals.append(data[sel][:, m].mean(axis=1))
    return {"maps": out.arr(_grid_maps(mnames, np.array(vals))), "times": list(a["times"])}


def cmd_evoked_measure(a, out):
    ep = S.epochs
    if ep is None:
        raise ValueError("Create epochs first.")
    data = _evoked_data(a["condition"]) * 1e6
    m = (ep.times >= a["tmin"]) & (ep.times <= a["tmax"])
    if not m.any():
        raise ValueError("The window is outside the epoch.")
    seg, tt = data[:, m], ep.times[m]
    mode = a.get("mode", "pos")
    idx = seg.argmax(axis=1) if mode == "pos" else seg.argmin(axis=1) if mode == "neg" else np.abs(seg).argmax(axis=1)
    rows = [
        {
            "channel": n,
            "peak_uv": float(seg[i, idx[i]]),
            "latency_ms": float(tt[idx[i]] * 1000),
            "mean_uv": float(seg[i].mean()),
        }
        for i, n in enumerate(ep.ch_names)
    ]
    return {"rows": rows}


# --------------------------------------------------------------------------- #
# Time-frequency
# --------------------------------------------------------------------------- #
def cmd_tfr(a, out):
    raw = S.raw
    ch = a["channel"]
    fmin, fmax = float(a.get("fmin", 2.0)), float(a.get("fmax", 40.0))
    freqs = np.linspace(fmin, fmax, int(a.get("n_freqs", 39)))
    if S.epochs is not None and a.get("condition") and ch in S.epochs.ch_names:
        ep = S.epochs[a["condition"]]
        x = ep.get_data(picks=[ch])
        length = x.shape[-1] / ep.info["sfreq"]
        limit = 0.85 * length * np.pi / 5.0          # longest wavelet that fits, in cycles per Hz
        freqs = freqs[freqs * limit >= 1.5]
        if freqs.size < 2:
            raise ValueError("The epochs are too short for a time-frequency map.")
        n_cycles = np.minimum(np.maximum(2.0, freqs / 2.0), freqs * limit)
        power = mne.time_frequency.tfr_array_morlet(
            x, ep.info["sfreq"], freqs, n_cycles=n_cycles, output="power",
        ).mean(axis=0)[0]
        times = ep.times
        base = times < 0
        if base.sum() >= 2:
            ref = power[:, base].mean(axis=1, keepdims=True)
            db, unit = 10 * np.log10(power / ref), "dB vs. baseline"
        else:
            db, unit = 10 * np.log10(power * 1e12), "dB (µV²)"
        return {"kind": "epochs", "times": out.arr(times), "freqs": out.arr(freqs), "power": out.arr(db), "unit": unit}

    from scipy.signal import spectrogram
    sf = raw.info["sfreq"]
    x = raw.get_data(picks=[ch])[0]
    nper = int(sf * 2)
    f, t, sxx = spectrogram(x, fs=sf, nperseg=nper, noverlap=int(nper * 0.75))
    m = (f >= fmin) & (f <= fmax)
    db = 10 * np.log10(sxx[m] * 1e12 + 1e-20)
    if db.shape[1] > 1200:
        k = db.shape[1] // 1200 + 1
        n = (db.shape[1] // k) * k
        db = db[:, :n].reshape(db.shape[0], -1, k).mean(axis=2)
        t = t[:n].reshape(-1, k).mean(axis=1)
    return {"kind": "raw", "times": out.arr(t), "freqs": out.arr(f[m]), "power": out.arr(db), "unit": "dB (µV²/Hz)"}


# --------------------------------------------------------------------------- #
# Code export
# --------------------------------------------------------------------------- #
def _step_code(step, highpass=0.0):
    t, p = step["type"], step["params"]
    if t == "filter":
        lo, hi = p.get("l_freq"), p.get("h_freq")
        what = "Band-pass" if lo and hi else "High-pass" if lo else "Low-pass"
        return (f"{what} filter", "Remove slow drift and/or fast noise outside the range of interest.",
                f"raw.filter(l_freq={lo!r}, h_freq={hi!r})")
    if t == "notch":
        freqs = _notch_freqs(S.raw0, p)
        return ("Notch filter", "Remove mains interference at the power-line frequency and its harmonics.",
                f"raw.notch_filter(freqs={freqs!r})")
    if t == "resample":
        return ("Resample", "Lower the sampling rate to make later steps faster.",
                f"raw.resample({float(p['sfreq'])!r})")
    if t == "reference":
        if p.get("kind", "average") == "average":
            return ("Re-reference", "Express every channel relative to the average of all EEG channels.",
                    'raw.set_eeg_reference("average", projection=False)')
        return ("Re-reference", "Express every channel relative to the chosen reference channels.",
                f"raw.set_eeg_reference(ref_channels={list(p['channels'])!r})")
    if t == "crop":
        return ("Crop", "Keep only part of the recording.",
                f"raw.crop(tmin={float(p.get('tmin') or 0)!r}, tmax={p.get('tmax')!r})")
    if t == "bads":
        return ("Mark bad channels", "Exclude unusable channels from later steps.",
                f"raw.info[\"bads\"] = {list(p['channels'])!r}")
    if t == "interpolate":
        return ("Interpolate bad channels", "Rebuild bad channels from their neighbours.",
                "raw.interpolate_bads(reset_bads=True)")
    if t == "drop":
        return ("Drop channels", "Remove channels that are not needed.",
                f"raw.drop_channels({list(p['channels'])!r})")
    if t == "ica":
        n = p.get("n_components", 15)
        code = (
            f"ica = mne.preprocessing.ICA(n_components={n!r}, method={p.get('method', 'picard')!r}, "
            f"random_state={int(p.get('seed', 97))!r}, max_iter=500)\n"
            + ("ica_input = raw.copy().filter(1.0, None)  # ICA works best on high-pass filtered data\n"
               if highpass < 1.0 else "ica_input = raw\n")
            + f"ica.fit(ica_input, decim={max(1, int(round(S.raw0.info['sfreq'] / 125.0)))}, reject_by_annotation=True)\n"
            f"ica.exclude = {[int(i) for i in p.get('exclude', [])]!r}  # components judged to be artifacts\n"
            "ica.apply(raw)"
        )
        return ("ICA artifact removal",
                "Split the signal into independent components and remove those that are eye, muscle or heart artifacts.",
                code)
    return (t, "", f"# unsupported step: {t}")


def _sections():
    sec = []
    setup = ["import mne", "", S.load_code or "raw = ..."]
    if S.setup.get("types"):
        setup.append(f"raw.set_channel_types({S.setup['types']!r})")
    if S.setup.get("rename"):
        setup.append(f"raw.rename_channels({S.setup['rename']!r})")
    if S.setup.get("montage"):
        setup.append(f'raw.set_montage("{S.setup["montage"]}", match_case=False, on_missing="ignore")')
    sec.append(("Load the recording", "Read the file and describe the channels.", "\n".join(setup)))

    file_keys = set()
    user = []
    for x in S.annots:
        user.append(x)
    if user and any(x["description"].upper().startswith("BAD") for x in user):
        bad = [x for x in user if x["description"].upper().startswith("BAD")]
        code = (
            "raw.annotations.append(\n"
            f"    onset={[round(x['onset'], 3) for x in bad]!r},\n"
            f"    duration={[round(x['duration'], 3) for x in bad]!r},\n"
            f"    description={[x['description'] for x in bad]!r},\n)"
        )
        sec.append(("Mark bad segments", "Stretches of data to leave out of the analysis.", code))
    del file_keys

    highpass = float(S.raw0.info["highpass"] or 0.0)
    for s in S.steps:
        if s.get("enabled", True):
            sec.append(_step_code(s, highpass))
            if s["type"] == "filter" and s["params"].get("l_freq") is not None:
                highpass = max(highpass, float(s["params"]["l_freq"]))

    if S.psd_cfg:
        c = S.psd_cfg
        n_fft = int(c["window"] * S.raw.info["sfreq"])
        sec.append(("Power spectrum", "How much power the signal has at each frequency.",
                    f'spectrum = raw.compute_psd(method="welch", fmin={c["fmin"]!r}, fmax={c["fmax"]!r}, '
                    f"n_fft={n_fft}, n_overlap={n_fft // 2})\nspectrum.plot()"))
    if S.epochs_cfg:
        c = S.epochs_cfg
        eid = {k: i + 1 for i, k in enumerate(c["conditions"])}
        base = None if c["baseline"] is None else tuple(c["baseline"])
        rej = None if not c["reject_uv"] else {"eeg": float(c["reject_uv"]) * 1e-6}
        code = (
            f"events, event_id = mne.events_from_annotations(raw, event_id={eid!r})\n"
            f"epochs = mne.Epochs(raw, events, event_id=event_id, tmin={c['tmin']!r}, tmax={c['tmax']!r},\n"
            f"                    baseline={base!r}, reject={rej!r}, preload=True)\n"
            "evokeds = {name: epochs[name].average() for name in event_id}\n"
            "mne.viz.plot_compare_evokeds(evokeds, combine=\"gfp\")\n"
            "for name, evoked in evokeds.items():\n"
            "    evoked.plot_joint(title=name)"
        )
        sec.append(("Epochs and evoked responses",
                    "Cut the recording around each event and average to reveal the brain's response.", code))
    sec.append(("Save", "Write the cleaned recording to disk.",
                'raw.save("cleaned_raw.fif", overwrite=True)'))
    return sec


def cmd_script(a, out):
    sec = _sections()
    head = (
        f"Created with EEG Workbench {VERSION}\n"
        f"Recording: {S.name}\n"
        f"Requires: mne {mne.__version__}\n\n"
        "If this helped your work, please cite EEG Workbench and MNE-Python."
    )
    py = ['"""' + head + '"""']
    for title, why, code in sec:
        py.append(f"# --- {title} ---\n" + (f"# {why}\n" if why else "") + code)
    cells = [{"cell_type": "markdown", "metadata": {}, "source": "# EEG analysis\n\n" + head.replace("\n", "  \n")},
             {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
              "source": "%pip install -q mne"}]
    for title, why, code in sec:
        cells.append({"cell_type": "markdown", "metadata": {}, "source": f"## {title}\n\n{why}"})
        cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": code})
    nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python",
                                                      "name": "python3"}}, "nbformat": 4, "nbformat_minor": 5}
    return {"py": "\n\n".join(py) + "\n", "ipynb": json.dumps(nb, indent=1),
            "sections": [{"title": t, "why": w, "code": c} for t, w, c in sec]}


# --------------------------------------------------------------------------- #
# Data export
# --------------------------------------------------------------------------- #
def cmd_export(a, out):
    what, fmt = a.get("what", "raw"), a.get("format", "fif")
    os.makedirs("/tmp/export", exist_ok=True)
    for f in os.listdir("/tmp/export"):
        os.remove(os.path.join("/tmp/export", f))
    if what == "epochs":
        if S.epochs is None:
            raise ValueError("Create epochs first.")
        S.epochs.save("/tmp/export/lab-epo.fif", overwrite=True)
    elif what == "evoked":
        if S.epochs is None:
            raise ValueError("Create epochs first.")
        mne.write_evokeds("/tmp/export/lab-ave.fif",
                          [S.epochs[c].average() for c in S.epochs.event_id], overwrite=True)
    elif what == "original":
        S.raw0.copy().set_annotations(mne.Annotations(
            [x["onset"] for x in S.annots], [x["duration"] for x in S.annots],
            [x["description"] for x in S.annots])).save("/tmp/export/eeg_workbench_demo_raw.fif", overwrite=True)
    elif fmt == "fif":
        S.raw.save("/tmp/export/cleaned_raw.fif", overwrite=True)
    elif fmt == "edf":
        mne.export.export_raw("/tmp/export/cleaned.edf", S.raw, overwrite=True)
    elif fmt == "brainvision":
        mne.export.export_raw("/tmp/export/cleaned.vhdr", S.raw, overwrite=True)
    else:
        raise ValueError(f"Unknown format: {fmt}")

    files = sorted(os.listdir("/tmp/export"))
    if len(files) == 1:
        name = files[0]
        with open(os.path.join("/tmp/export", name), "rb") as fh:
            blob = fh.read()
    else:
        name = "cleaned_brainvision.zip"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(os.path.join("/tmp/export", f), f)
        blob = buf.getvalue()
    return {"filename": name, "bytes": out.arr(np.frombuffer(blob, dtype="u1"), dtype="u1")}


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
COMMANDS = {
    "load": cmd_load,
    "demo": cmd_demo,
    "info": cmd_info,
    "set_steps": cmd_set_steps,
    "setup": cmd_setup,
    "window": cmd_window,
    "overview": cmd_overview,
    "annotate": cmd_annotate,
    "detect_bads": cmd_detect_bads,
    "psd": cmd_psd,
    "ica_info": cmd_ica_info,
    "epochs": cmd_epochs,
    "evoked_maps": cmd_evoked_maps,
    "evoked_measure": cmd_evoked_measure,
    "tfr": cmd_tfr,
    "script": cmd_script,
    "export": cmd_export,
}


def handle(cmd, args_json="{}"):
    """Entry point used by the worker. Returns (json_text, [flat arrays])."""
    out = Out()
    try:
        res = COMMANDS[cmd](json.loads(args_json), out)
        return json.dumps({"ok": True, "result": res}, default=_jsonable), out.buffers
    except Exception as exc:  # report, never crash the worker
        return json.dumps({
            "ok": False,
            "error": str(exc) or exc.__class__.__name__,
            "trace": traceback.format_exc(limit=6),
        }), []
