# Coordinate Overlay Technique

Read this reference before filling a non-trivial flat PDF. For ordinary
AcroForm documents, named fields are safer and this guide is unnecessary.

## Coordinate system

PyMuPDF uses PDF points (1 point is 1/72 inch), with the origin at the top-left.
The x axis increases to the right and the y axis increases downward.
`insert_text((x, y), ...)` places the text baseline at `(x, y)`.

The PNG grids produced by `inspect_pdf.py` use the same coordinates. No manual
pixel-to-point conversion is needed.

## Anchor to existing text

For a checkbox, signature line or narrow field, locate a nearby printed label
and derive an offset from its exact PDF word bounds:

```python
import fitz

doc = fitz.open("form.pdf")
for word in doc[0].get_text("words"):
    if word[4] == "Consent":
        print(word[:5])
```

A word tuple starts with `(x0, y0, x1, y1, text)`. Position the field relative
to those bounds and verify the result in a high-resolution clipped preview.
Do not treat an estimated offset as final evidence.

## Text baselines and boxes

Use the line on which the text should sit as the initial y coordinate. If the
text falls below the line, decrease y; if it floats too high, increase y.
Adjust in small steps.

For a checkbox, place the X near the horizontal centre and use the lower part
of the box as the initial baseline. Verify at high zoom.

## Character-by-character fields

Use `spread.step` for account numbers, dates or identifiers printed as separate
boxes:

```json
{
  "page": 0,
  "x": 70,
  "y": 410,
  "text": "XX00EXAMPLE0000000000000000",
  "spread": {"step": 17.5}
}
```

Measure `step` from two adjacent boxes on the coordinate grid. `spread.skip`
accepts zero-based character indexes that should not be drawn while retaining
their spacing.

## Long text and fonts

The overlay script does not wrap text automatically. Reduce the per-item
`size`, split the content into explicitly positioned lines, or leave the field
for manual completion rather than allowing text to overlap legal wording.

The built-in PDF font is suitable for common Latin text. For another script or
missing glyph, use a locally available, appropriately licensed TTF/OTF through
the top-level `font_file` configuration. Do not bundle private or unlicensed
fonts.

## Signature images

Insert a signature only after explicit authorisation from the signer for the
specific document. Prepare the image locally with `prepare_signature.py` and
keep the original and prepared image outside source control.

Use a transparent PNG and a rectangle whose proportions are close to the
signature. Avoid stretching it unnaturally. Place it so the visible stroke
rests on the intended line, then inspect the result on a pure white background
and in a clipped high-resolution preview.

The fill script downsizes very large inserted images to the resolution needed
for the target rectangle. This avoids embedding a multi-megapixel source into
a small signature area.

## Focused verification

Render a critical region rather than relying only on a full-page preview:

```python
clip = fitz.Rect(x0, y0, x1, y1)
pix = doc[page_number].get_pixmap(clip=clip, dpi=240)
pix.save("verification-region.png")
```

Check every populated field, not only representative examples. Treat the
completed file as a draft until the user has reviewed it. Filling a form does
not authorise signing, sending or submission.
