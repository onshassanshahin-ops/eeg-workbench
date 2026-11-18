import { ArrowLeft, ArrowRight, Check, GraduationCap, X } from "lucide-react";
import { STEP_DEFS } from "../steps";
import { useLab } from "../store";
import type { Step } from "../types";

type Lab = ReturnType<typeof useLab.getState>;
type TourStep = {
  title: string;
  body: string;
  cta?: string;
  act?: (s: Lab) => Promise<unknown> | void;
  done?: (s: Lab) => boolean;
  enter?: (s: Lab) => void;
};

const uid = () => Math.random().toString(36).slice(2, 10);
const has = (s: Lab, type: string) => s.steps.some((x) => x.type === type && x.enabled);

const STEPS: TourStep[] = [
  {
    title: "Meet the recording",
    body: "This is a simulated four-minute EEG from a listening task. Scroll with the mouse wheel. The large bumps on Fp1 and Fp2 are eye blinks, and P7 is far noisier than its neighbours. We will fix both, then find the brain's response to the rare sounds.",
    enter: (s) => s.setTab("signal"),
  },
  {
    title: "Remove drift and mains hum",
    body: "The traces wander slowly up and down, and carry a fine 50 Hz ripple from mains electricity. A 1–40 Hz filter removes both and leaves the brain rhythms.",
    cta: "Add the filter",
    act: (s) => s.addStep("filter", { l_freq: 1, h_freq: 40 }, STEP_DEFS.filter.verb),
    done: (s) => has(s, "filter"),
    enter: (s) => s.setTab("signal"),
  },
  {
    title: "Repair the noisy channel",
    body: "P7 is unusable. Lab marks it as bad and rebuilds it from the electrodes around it, so the full set of channels is kept for scalp maps.",
    cta: "Mark and repair P7",
    act: (s) => {
      const extra: Step[] = [
        { id: uid(), type: "bads", params: { channels: ["P7"] }, enabled: true },
        { id: uid(), type: "interpolate", params: {}, enabled: true },
      ];
      return s.applySteps([...s.steps, ...extra], "Repairing P7");
    },
    done: (s) => has(s, "interpolate"),
    enter: (s) => s.setTab("signal"),
  },
  {
    title: "Separate the sources",
    body: "Blinks are still there, and they are far larger than brain activity. ICA splits the recording into independent components so the blinks can be taken out on their own.",
    cta: "Run ICA",
    act: (s) => s.addStep("ica", STEP_DEFS.ica.defaults(s.info!), STEP_DEFS.ica.verb).then(() => s.setTab("components")),
    done: (s) => has(s, "ica"),
  },
  {
    title: "Remove the blink component",
    body: "Each card is one component: where it sits on the scalp, and its spectrum. A blink component is strongest at the very front of the head. Lab has labelled the likely artifacts — remove them.",
    cta: "Remove the suggested ones",
    act: (s) => {
      const step = s.steps.find((x) => x.type === "ica");
      const ids = Object.keys(s.ica?.suggest ?? {}).map(Number);
      if (step) return s.updateStep(step.id, { ...step.params, exclude: ids }, "Rebuilding the signal");
    },
    done: (s) => (s.ica?.exclude.length ?? 0) > 0,
    enter: (s) => s.setTab("components"),
  },
  {
    title: "See what changed",
    body: "The amber trace underneath is the original signal; the main trace is the cleaned one. The blinks, the drift and the noisy channel are gone, and the brain activity is untouched.",
    enter: (s) => {
      s.setTab("signal");
      s.setView({ compare: true, uvPerRow: 60 });
    },
  },
  {
    title: "Find the brain's response",
    body: "The listener heard common sounds and rare target sounds. Averaging the signal around each sound cancels random activity and leaves the response. Rare targets should produce a positive wave about 300–400 ms later at the back of the head: the P300.",
    cta: "Average the epochs",
    act: (s) =>
      s.computeErp({ conditions: ["standard", "target"], tmin: -0.2, tmax: 0.8, baseline: [-0.2, 0], reject_uv: 150 }).then(() => s.setTab("erp")),
    done: (s) => !!s.erp && s.erpRev === s.rev,
    enter: (s) => s.setTab("erp"),
  },
  {
    title: "Keep your work",
    body: "Every step you made is written out as Python code that repeats the analysis exactly. Download it as a script or a notebook, along with the cleaned data. That is the whole workflow — now try it on your own recording.",
    enter: (s) => s.setTab("export"),
  },
];

export function Tour() {
  const tour = useLab((s) => s.tour);
  const state = useLab();
  if (!tour.active || !state.info) return null;
  const i = Math.min(tour.step, STEPS.length - 1);
  const step = STEPS[i];
  const done = step.done ? step.done(state) : true;
  const go = (n: number) => {
    state.setTour({ step: n });
    STEPS[n].enter?.(useLab.getState());
  };

  return (
    <div className="tour" role="dialog" aria-label="Guided walkthrough">
      <header>
        <span><GraduationCap size={14} /> Walkthrough · {i + 1} of {STEPS.length}</span>
        <button className="icon" title="Close the walkthrough" onClick={() => state.setTour({ active: false })}><X size={15} /></button>
      </header>
      <div className="tour-dots">{STEPS.map((_, k) => <i key={k} className={k < i ? "past" : k === i ? "now" : ""} />)}</div>
      <h3>{step.title}</h3>
      <p>{step.body}</p>
      <footer>
        <button className="btn ghost" disabled={i === 0} onClick={() => go(i - 1)}><ArrowLeft size={14} /> Back</button>
        {step.act && !done ? (
          <button className="btn primary" disabled={!!state.busy} onClick={() => void step.act!(useLab.getState())}>{step.cta}</button>
        ) : i < STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => go(i + 1)}>{step.act ? <Check size={14} /> : null} Next <ArrowRight size={14} /></button>
        ) : (
          <button className="btn primary" onClick={() => state.setTour({ active: false })}><Check size={14} /> Finish</button>
        )}
      </footer>
    </div>
  );
}
