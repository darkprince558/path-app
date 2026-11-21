"""Local trial runner: send photos from a folder to Gemini and record evidence.

This is a developer and demo tool, not part of the library API Sam calls. It
reads a capture folder, runs one ``LandmarkService`` request, and writes a
private run folder with ``result.json`` and a side-by-side ``report.html``.
Organizer decisions and summary counts support the Gemini prize evidence.

Run ``python -m path_gemini.trial --help``.
"""
