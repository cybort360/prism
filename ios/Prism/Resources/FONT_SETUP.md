# F5.6 font setup

Prism's approved visual system uses F5.6 for display moments and the system sans-serif for body/UI text.

The font binary is intentionally not committed or redistributed by this repository.

1. Obtain F5.6 from its publisher under its applicable license.
2. Add the font file to the Prism Xcode target.
3. Ensure it is included in Copy Bundle Resources.
4. Add the font filename under `UIAppFonts` in `Info.plist` if Xcode does not register it automatically.
5. `PrismTheme.display` checks `F5.6`, `F5.6-Regular`, and `F5_6` and falls back safely during development.

Do not use F5.6 for long paragraphs. It is intentionally limited to balances, amounts, major screen titles, and onboarding statements.
