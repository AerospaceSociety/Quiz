"""
scripts/provision_jotform.py
-----------------------------
Provisions the server-relay submission fields onto your Jotform form via the Jotform API.
It enables the mirror in `config/settings.json`; credentials stay outside the repository.

Usage:
    export JOTFORM_API_KEY="your-api-key"
    python scripts/provision_jotform.py

Optional flags:
    --form-id=262450769915063
    --api-base=https://api.jotform.com
    --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse
import requests

ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = ROOT / "config" / "settings.json"

FIELDS_SPEC = [
    {"type": "control_textbox",  "name": "schoolUid",     "text": "School UID"},
    {"type": "control_textbox",  "name": "teamId",        "text": "Team ID"},
    {"type": "control_textbox",  "name": "candidateName", "text": "Candidate Name"},
    {"type": "control_textbox",  "name": "division",      "text": "Division"},
    {"type": "control_textbox",  "name": "sessionId",     "text": "Session ID"},
    {"type": "control_textbox",  "name": "answered",      "text": "Answered"},
    {"type": "control_textbox",  "name": "verdict",       "text": "Verdict"},
    {"type": "control_textbox",  "name": "checksum",      "text": "SHA-256 Checksum"},
    {"type": "control_textarea", "name": "responsesJson", "text": "Responses JSON"},
    {"type": "control_textarea", "name": "summaryText",   "text": "Summary Text"},
]


def load_settings():
    if not SETTINGS_PATH.exists():
        sys.exit(f"Error: {SETTINGS_PATH} not found.")
    return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))


def save_settings(settings):
    SETTINGS_PATH.write_text(json.dumps(settings, indent=2) + "\n", encoding="utf-8")
    print(f"[OK] Updated {SETTINGS_PATH}")


def get_existing_questions(api_base, form_id, api_key):
    resp = requests.get(
        f"{api_base}/form/{form_id}/questions",
        headers={"APIKEY": api_key},
        timeout=30,
        allow_redirects=False
    )
    if resp.status_code == 401:
        sys.exit("Error: Jotform API key is invalid or unauthorized. Ensure it has Full Access.")
    if resp.status_code != 200:
        sys.exit(f"Error fetching questions: Jotform returned HTTP {resp.status_code}.")
    resp.raise_for_status()
    body = resp.json()
    if body.get("responseCode") != 200:
        sys.exit(f"Error fetching questions: {body}")
    return body.get("content", {})


def add_question(api_base, form_id, api_key, field_spec, order):
    data = {
        "question[type]": field_spec["type"],
        "question[text]": field_spec["text"],
        "question[name]": field_spec["name"],
        "question[order]": str(order),
    }
    resp = requests.post(
        f"{api_base}/form/{form_id}/questions",
        headers={"APIKEY": api_key},
        data=data,
        timeout=30,
        allow_redirects=False
    )
    if resp.status_code != 200:
        print(f"Warning: Jotform returned HTTP {resp.status_code} for {field_spec['name']}.", file=sys.stderr)
        return None
    resp.raise_for_status()
    body = resp.json()
    if body.get("responseCode") != 200:
        print(f"Warning: Failed to add question {field_spec['name']}: {body}", file=sys.stderr)
        return None
    return body.get("content")


def update_form_title(api_base, form_id, api_key, title="Quizzitch Exam Submissions"):
    try:
        response = requests.post(
            f"{api_base}/form/{form_id}/properties",
            headers={"APIKEY": api_key},
            data={"properties[title]": title},
            timeout=15,
            allow_redirects=False
        )
        body = response.json() if response.status_code == 200 else {}
        if response.status_code != 200 or body.get("responseCode") != 200:
            print("Note: Jotform did not confirm the form-title update.", file=sys.stderr)
    except Exception as e:
        print(f"Note: Could not update form title: {e}")


def main():
    parser = argparse.ArgumentParser(description="Provision Jotform fields for Quizzitch.")
    parser.add_argument("--form-id", default=None, help="Jotform Form ID")
    parser.add_argument("--api-base", default=os.environ.get("JOTFORM_API_BASE", "https://api.jotform.com"))
    parser.add_argument("--dry-run", action="store_true", help="Inspect without modifying")
    args = parser.parse_args()

    settings = load_settings()
    form_id = args.form_id or settings.get("jotform", {}).get("formId") or "262450769915063"
    api_key = os.environ.get("JOTFORM_API_KEY")
    api_base = args.api_base.rstrip("/")
    parsed_api_base = urlparse(api_base)
    if parsed_api_base.scheme != "https" or parsed_api_base.netloc not in {
        "api.jotform.com", "eu-api.jotform.com", "hipaa-api.jotform.com"
    } or parsed_api_base.path or parsed_api_base.query or parsed_api_base.fragment:
        sys.exit("Error: --api-base must be an approved HTTPS Jotform API hostname.")
    if not str(form_id).isdigit():
        sys.exit("Error: Form ID must contain digits only.")

    if not api_key:
        print("Error: Missing Jotform API key.", file=sys.stderr)
        print("Provide it through the JOTFORM_API_KEY environment variable.", file=sys.stderr)
        sys.exit(1)

    print(f"--- Provisioning Quizzitch Jotform Fields ---")
    print(f"Target Form ID: {form_id}")
    print(f"API Base:       {api_base}")

    # 1. Fetch current questions
    existing_questions = get_existing_questions(api_base, form_id, api_key)
    existing_by_name = {q.get("name"): (qid, q) for qid, q in existing_questions.items() if q.get("name")}
    existing_by_text = {q.get("text"): (qid, q) for qid, q in existing_questions.items() if q.get("text")}

    print(f"Found {len(existing_questions)} existing elements on the form.")

    # 2. Add missing fields
    order_start = len(existing_questions) + 1
    added_count = 0

    if not args.dry_run:
        update_form_title(api_base, form_id, api_key)

    for idx, spec in enumerate(FIELDS_SPEC):
        name = spec["name"]
        text = spec["text"]
        match = existing_by_name.get(name)
        if not match:
            text_match = existing_by_text.get(text)
            if text_match and text_match[1].get("name") != name:
                sys.exit(f"Error: Existing field '{text}' has internal name '{text_match[1].get('name')}', expected '{name}'. Rename it in Jotform before provisioning.")
            match = text_match

        if match:
            qid, q = match
            print(f"  [EXISTS] {text} -> qid: {qid} (name: {q.get('name')})")
        else:
            if args.dry_run:
                print(f"  [DRY-RUN WOULD ADD] {text} ({spec['type']})")
            else:
                print(f"  [ADDING] {text} ({spec['type']})...")
                res = add_question(api_base, form_id, api_key, spec, order=order_start + idx)
                if res:
                    added_count += 1

    if not args.dry_run:
        if "jotform" not in settings:
            settings["jotform"] = {}
        settings["jotform"]["enabled"] = True
        save_settings(settings)
        print("\n[SUCCESS] Form provisioned and Jotform mirroring enabled.")
        print(f"Set the server-side JOTFORM_FORM_ID to {form_id} before deployment.")
    else:
        print("\n[DRY RUN COMPLETE] No changes were written.")


if __name__ == "__main__":
    main()
