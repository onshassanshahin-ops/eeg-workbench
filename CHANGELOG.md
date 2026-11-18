# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First public version.

### Added

- Interactive viewer for long, many-channel EEG recordings, with events, annotations, bad-channel and bad-segment marking, and a comparison against the original signal.
- Pipeline of editable, reorderable steps with undo and redo: filters, notch, re-referencing, resampling, cropping, automatic bad-channel detection and interpolation, and ICA artifact removal with a component review screen.
- Analyses: evoked responses (ERPs), power spectrum and band power, and time-frequency maps.
- Export of the whole session as an MNE-Python script or Jupyter notebook; export of cleaned data as FIF, EDF or BrainVision, plus epochs, averages, figures and tables.
- Import of EDF/BDF, BrainVision, EEGLAB, FIF and GDF recordings.
- Built-in demo recording and guided walkthrough, light and dark themes.
- Analysis engine running MNE-Python under Pyodide in a Web Worker, so recordings never leave the user's computer.
