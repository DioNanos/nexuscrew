---
name: fill-forms
description: Use for inspecting, filling and visually validating local PDF or DOCX forms, including AcroForm fields, coordinate-based overlays, checkboxes, character boxes and an explicitly authorised signature image. Trigger when the user asks to fill in a PDF, complete a form, prepare paperwork for signature, populate a DOCX template or inspect a form before completion. Keep processing local, preserve the original, never invent personal data, and never sign or submit a document without explicit authorisation.
---

# Fill Forms

Fill PDF and DOCX forms locally with the bundled scripts. Prefer named PDF
fields when they exist; use coordinate overlays only for flat forms or scans.
Always preserve the blank source and visually verify a new output file.

## Select the response language

Choose the language for questions, progress updates and explanations in this
order:

1. the user's explicit language preference;
2. the language of the current request;
3. a reliable client or system locale;
4. English.

Do not translate field values, names, identifiers, legal wording or document
text merely to match the response language. Preserve the document's language
unless the user explicitly requests a translation.

## Apply the safety boundary

- Work on local copies. Do not upload a form or its contents to an external
  service unless the user explicitly requests and authorises that transfer.
- Never invent a name, address, identifier, account number, date, selection or
  legal answer. Ask for missing data or leave the field visibly unresolved.
- Treat signatures as sensitive assets. Insert a signature image only when the
  authorised signer supplies it and explicitly asks for insertion into the
  identified document. Never keep signature images in source control.
- Filling is not signing, sending or submitting. Obtain separate explicit
  authorisation before any consequential external action.
- Never overwrite the blank source. The scripts reject identical source and
  output paths and require `--overwrite` before replacing an existing output.
- Generated documents, prepared signatures and preview images are written as
  owner-only files; generated preview/grid directories are owner-only.
- Keep configuration files containing personal data out of source control and
  remove temporary previews when the user no longer needs them.

## Prepare dependencies

Resolve every script relative to this `SKILL.md`. The scripts require Python 3
and do not install packages automatically. Check the environment first:

```bash
python3 --version
python3 -c "import fitz"
```

For PDF image/signature handling and DOCX support, the complete dependency set
is listed in `requirements.txt`. If dependencies are missing, explain what is
needed and ask before creating a virtual environment or installing packages.
Never modify the system Python implicitly.

## Inspect first

Run the inspector before filling a PDF:

```bash
python3 <skill-dir>/scripts/inspect_pdf.py form.pdf
```

It reports AcroForm fields and produces coordinate-grid PNG files next to the
source. Review those images rather than guessing positions. Replacing an
existing grid requires an intentional `--overwrite`.

- If named fields exist, prefer `mode: "acroform"`.
- For a flat PDF or scan, use `mode: "overlay"`.
- Use `mode: "both"` only when the document genuinely mixes both forms.

For precise checkboxes and signature lines, anchor coordinates to nearby PDF
text rather than estimating from a full-page image. Read
[`references/overlay-technique.md`](references/overlay-technique.md) before a
non-trivial overlay.

## Fill a PDF

Create a JSON configuration beside the working copy:

```json
{
  "src": "blank-form.pdf",
  "out": "completed-form.pdf",
  "mode": "overlay",
  "font_size": 9,
  "overlay": [
    {"page": 0, "x": 220, "y": 190, "text": "Example Person"},
    {"page": 0, "x": 62, "y": 332, "check": true},
    {
      "page": 1,
      "x": 70,
      "y": 410,
      "text": "XX00EXAMPLE0000000000000000",
      "spread": {"step": 17.5}
    }
  ]
}
```

Relative paths are resolved from the configuration file. Run:

```bash
python3 <skill-dir>/scripts/fill_pdf.py form-data.json
```

The script creates the output and a `<output>_preview/` directory. Use
`--overwrite` only for an intentional revision of that output.

Supported overlay items:

- `text`, `x`, `y`, optional `size`;
- `check: true`, `x`, `y`, optional `size`;
- `text` plus `spread.step` and optional `spread.skip` for character boxes;
- `image` plus `rect: [x0, y0, x1, y1]` for an explicitly authorised local
  image;
- optional top-level `font_file` for a user-provided TTF/OTF when the built-in
  PDF font cannot represent the required text.

For AcroForm mode, provide `"acroform": {"field-name": "value"}` and booleans
for checkboxes. Unknown requested field names fail closed instead of silently
producing an incomplete form.

## Fill a DOCX template

Inspect its paragraphs and tables:

```bash
python3 <skill-dir>/scripts/dump_docx.py template.docx
```

Use explicit `{{placeholder}}` tokens whenever possible, then run:

```bash
python3 <skill-dir>/scripts/fill_docx.py template.docx completed.docx \
  --data form-data.json
```

Plain-text key replacement is available only with `--literal-keys` because it
can otherwise replace unintended text. Unused data keys fail closed unless the
user deliberately chooses `--allow-unused`.

## Verify before handoff

1. Review every generated preview page at full size.
2. Zoom critical regions such as checkboxes, character boxes and signatures.
3. Compare every populated value with the user's authoritative source.
4. Confirm that the original file is unchanged and the output has a distinct
   name.
5. Show the final preview or document to the user before calling it ready.
6. State clearly which fields remain empty, uncertain, unsigned or unsubmitted.
