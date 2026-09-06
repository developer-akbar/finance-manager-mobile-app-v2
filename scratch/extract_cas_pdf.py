import os
from pypdf import PdfReader

for pdf_name in ["CAS_Fareeda Groww_Liquid_MF.pdf", "CAS_Ammi Groww_Liquid_MF.pdf"]:
    if os.path.exists(pdf_name):
        print(f"=== {pdf_name} ===")
        reader = PdfReader(pdf_name)
        print(f"Total pages: {len(reader.pages)}")
        full_text = ""
        for idx, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            full_text += f"\n--- Page {idx+1} ---\n" + text
        out_txt = f"scratch/{pdf_name}.txt"
        with open(out_txt, "w", encoding="utf-8") as f:
            f.write(full_text)
        print(f"Saved extracted text to {out_txt} ({len(full_text)} chars)")
        # Print first 1000 chars
        print(full_text[:1000])
