# GB drawing rules — implementation baseline

The drawing engine should treat standards as versioned configuration, not prompt text.

Verified current items used by the initial ruleset:
- GB/T 4458.4-2003 — Mechanical drawings — Dimensioning.
- GB/T 4458.5-2003 — Dimension tolerances and fits indication.
- GB/T 4458.1-2002 — Views.
- GB/T 4458.6-2002 — Section views and sections.
- GB/T 4457.4-2002 — Lines.
- GB/T 4457.5-2013 — Representation of section areas.

Before Stage 2 release, add and verify the title-block, sheet, lettering, surface texture, geometrical tolerance and welding-symbol standards required by the target customer/industry.

Implementation principle: standards determine rendering/layout rules; exact geometry determines numeric values; user/company templates determine default tolerances/material/process notes.
