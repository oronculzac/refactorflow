# Social Preview Asset

This directory contains the source artwork for the `RefactorFlow` social preview.

- `social-preview.svg` is the editable source-of-truth asset.
- The composition is tuned for GitHub/social use at `1280x640`.
- The visual direction is intentionally technical: YAML-first, state-machine driven, reviewable slices, AI-assisted, and Codex-friendly without using product logos.

## Export

Prefer uploading a raster export to GitHub if SVG is not accepted in the social preview UI.

If `inkscape` is installed:

```bash
inkscape .github/assets/social-preview.svg \
  --export-type=png \
  --export-filename=.github/assets/social-preview.png \
  -w 1280 -h 640
```

If `rsvg-convert` is installed:

```bash
rsvg-convert -w 1280 -h 640 \
  .github/assets/social-preview.svg \
  -o .github/assets/social-preview.png
```

## Upload

1. Open the repository on GitHub.
2. Go to repository `Settings`.
3. Find the social preview section.
4. Upload the exported `social-preview.png`.

If GitHub accepts SVG directly in your current UI, keep the SVG as the design source anyway and export PNG for consistent sharing outside GitHub.
