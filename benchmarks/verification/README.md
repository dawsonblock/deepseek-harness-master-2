# Verification calibration artifacts

This directory contains versioned, machine-readable qualification summaries for the
Outcome Verification Engine. They are calibration evidence, not a claim that the
same FAR/FRR holds on every real-world task distribution.

`v0.12-calibration.json` contains:

- 1,600 labeled cases (500 valid / 1,100 invalid)
- global FAR/FRR and Wilson confidence intervals
- per-fault-class failure taxonomy
- verified-success accepted-precision uplift
- exact pack/verifier/trusted-check policy fingerprints
- the hash-bound observe -> enforce promotion receipt

The promotion receipt is valid only for the exact policy fingerprints represented by
that calibration. Any policy drift requires fresh calibration and automatically
returns the release verifier to observe mode.
