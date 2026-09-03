# PRISM display font slot

Place your licensed F5.6 `.otf` or `.ttf` file in this folder before generating the Xcode project.

The app registers bundled font files at runtime through `PrismFontRegistrar`, then `PrismTheme.display` resolves `F5.6`, `F5.6-Regular`, or `F5_6`.

Font binaries are intentionally not redistributed with this repository.
