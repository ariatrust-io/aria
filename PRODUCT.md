# Product

## Register

brand

## Users

Engineering leads, platform/SRE teams, and security/compliance officers at companies deploying autonomous AI agents to production. They arrive skeptical: they have seen agents delete databases and fabricate logs, and they are evaluating whether ARIA can be trusted to be the source of truth about what their agents did. Context of use: desk, deep evaluation mode, reading carefully. The dashboard user is an operator monitoring live agent fleets and responding to gate approvals, sometimes under incident pressure.

## Product Purpose

ARIA is trust and enforcement infrastructure for AI agents: cryptographic identity (DID), an immutable HMAC-signed audit trail sealed with Merkle proofs, a 5-dimension trust score, and human-in-the-loop gating that pauses destructive actions before they execute. Success: a visitor leaves convinced that ARIA's claims are verifiable evidence, not marketing; an operator can spot and act on a critical gate request in seconds.

## Brand Personality

Forensic, sober, verifiable. The voice of an audit report, not a pitch deck: calm, precise, evidence-first. The interface should feel like a cryptographic document you could submit in court. Emotional goals: earned confidence and gravity. Never hype, never urgency theater.

## Anti-references

- Generic dark-SaaS AI template: indigo/purple gradients on near-black, gradient text, glassmorphism cards, identical icon-card grids, uppercase tracked eyebrows over every section, 01/02/03 scaffolding, animated counter stat bars. This is exactly what the current landing looks like and exactly what we are leaving behind.
- Crypto/web3 hype aesthetics (neon glows, blockchain visual clichés). ARIA uses cryptography; it is not a token project.

## Design Principles

1. **Evidence over claims.** Show the artifact (the signed event, the Merkle root, the gate decision), not an icon that gestures at it. Real data beats decoration.
2. **Practice what you preach.** A product that sells auditability must itself read as precise and inspectable: visible structure, exact numbers, monospace where data lives.
3. **Calm authority.** Restraint is the brand. One committed accent used with intent; hierarchy carried by typography and spacing, not by glow.
4. **Critical states are unmissable.** In the dashboard, a CRITICAL gate request outranks everything else on screen, and never communicates by color alone.
5. **The reader is a skeptic.** Every section should survive the question "can I verify that?"

## Accessibility & Inclusion

WCAG 2.1 AA. Body text contrast >= 4.5:1, large text >= 3:1. Visible focus states. `prefers-reduced-motion` alternatives for every animation. Trust/risk states (trusted, suspicious, critical) must pair color with text or shape, never color alone.
