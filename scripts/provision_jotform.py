"""
scripts/provision_jotform.py
-----------------------------
Provisions the Quizzitch submission fields onto your Jotform form via the Jotform API
and automatically updates `config/settings.json` with the resulting field mapping.

Usage:
    export JOTFORM_API_KEY="your-api-key"
    python scripts/provision_jotform.py

Or pass it as a flag:
    python scripts/provision_jotform.py --api-key="your-api-key"

Optional flags:
    --form-id=262450769915063   (defaults to formId in config/settings.json)
    --api-base=https://api.jotform.com
    --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = ROOT / "config" / "settings.json"

FIELDS_SPEC = [
    {"type": "control_textbox",  "name": "schoolUid",     "text": "School UID",         "key": "schoolUid"},
    {"type": "control_textbox",  "name": "teamId",        "text": "Team ID",            "key": "teamId"},
    {"type": "control_textbox",  "name": "candidateName", "text": "Candidate Name",     "key": "candidateName"},
    {"type": "control_textbox",  "name": "division",      "text": "Division",           "key": "division"},
    {"type": "control_textbox",  "name": "sessionId",     "text": "Session ID",         "key": "sessionId"},
    {"type": "control_textbox",  "name": "answered",      "text": "Answered",           "key": "answered"},
    {"type": "control_textbox",  "name": "verdict",       "text": "Verdict",            "key": "verdict"},
    {"type": "control_textbox",  "name": "checksum",      "text": "SHA-256 Checksum",   "key": "checksum"},
    {"type": "control_textarea", "name": "responsesJson", "text": "Responses JSON",     "key": "responsesJson"},
    {"type": "control_textarea", "name": "summaryText",   "text": "Summary Text",       "key": "summaryText"},
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
        params={"apiKey": api_key},
        timeout=30
    )
    if resp.status_code == 401:
        sys.exit("Error: Jotform API key is invalid or unauthorized. Ensure it has Full Access.")
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
        params={"apiKey": api_key},
        data=data,
        timeout=30
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("responseCode") != 200:
        print(f"Warning: Failed to add question {field_spec['name']}: {body}", file=sys.stderr)
        return None
    return body.get("content")


def update_form_title(api_base, form_id, api_key, title="Quizzitch Exam Submissions"):
    try:
        requests.post(
            f"{api_base}/form/{form_id}/properties",
            params={"apiKey": api_key},
            data={"properties[title]": title},
            timeout=15
        )
    except Exception as e:
        print(f"Note: Could not update form title: {e}")


def main():
    parser = argparse.ArgumentParser(description="Provision Jotform fields for Quizzitch.")
    parser.add_argument("--api-key", default=os.environ.get("JOTFORM_API_KEY"), help="Jotform API Key (Full Access)")
    parser.add_argument("--form-id", default=None, help="Jotform Form ID")
    parser.add_argument("--api-base", default=os.environ.get("JOTFORM_API_BASE", "https://api.jotform.com"))
    parser.add_argument("--dry-run", action="store_true", help="Inspect without modifying")
    args = parser.parse_args()

    settings = load_settings()
    form_id = args.form_id or settings.get("jotform", {}).get("formId") or "262450769915063"

    if not args.api_key:
        print("Error: Missing Jotform API key.", file=sys.stderr)
        print("Provide it via environment variable: export JOTFORM_API_KEY=\"...\"", file=sys.stderr)
        print("Or pass it as a flag: python scripts/provision_jotform.py --api-key=\"...\"", file=sys.stderr)
        sys.exit(1)

    print(f"--- Provisioning Quizzitch Jotform Fields ---")
    print(f"Target Form ID: {form_id}")
    print(f"API Base:       {args.api_base}")

    # 1. Fetch current questions
    existing_questions = get_existing_questions(args.api_base, form_id, args.api_key)
    existing_by_name = {q.get("name"): (qid, q) for qid, q in existing_questions.items() if q.get("name")}
    existing_by_text = {q.get("text"): (qid, q) for qid, q in existing_questions.items() if q.get("text")}

    print(f"Found {len(existing_questions)} existing elements on the form.")

    # 2. Add missing fields
    order_start = len(existing_questions) + 1
    added_count = 0

    if not args.dry_run:
        update_form_title(args.api_base, form_id, args.api_key)

    for idx, spec in enumerate(FIELDS_SPEC):
        name = spec["name"]
        text = spec["text"]
        match = existing_by_name.get(name) or existing_by_text.get(text)

        if match:
            qid, q = match
            print(f"  [EXISTS] {text} -> qid: {qid} (name: {q.get('name')})")
        else:
            if args.dry_run:
                print(f"  [DRY-RUN WOULD ADD] {text} ({spec['type']})")
            else:
                print(f"  [ADDING] {text} ({spec['type']})...")
                res = add_question(args.api_base, form_id, args.api_key, spec, order=order_start + idx)
                if res:
                    added_count += 1

    # 3. Refresh questions to construct fieldMap
    if not args.dry_run:
        print("\nRefreshing question IDs from Jotform...")
        updated_questions = get_existing_questions(args.api_base, form_id, args.api_key)
    else:
        updated_questions = existing_questions

    # Construct the exact HTML input name: "q{qid}_{name}" for direct form submission
    field_map = {}
    for spec in FIELDS_SPEC:
        key = spec["key"]
        name = spec["name"]
        text = spec["text"]

        matched_qid = None
        matched_name = name
        for qid, q in updated_questions.items():
            if q.get("name") == name or q.get("text") == text:
                matched_qid = qid
                matched_name = q.get("name") or name
                break

        if matched_qid:
            field_map[key] = f"q{matched_qid}_{matched_name}"
        else:
            # Fallback to standard convention
            field_map[key] = f"q{order_start}_{name}"

    print("\nConstructed fieldMap:")
    print(json.dumps(field_map, indent=2))

    if not args.dry_run:
        # Update settings.json
        if "jotform" not in settings:
            settings["jotform"] = {}
        settings["jotform"]["enabled"] = True
        settings["jotform"]["formId"] = str(form_id)
        settings["jotform"]["submitUrl"] = "https://submit.jotform.com/submit/"
        settings["jotform"]["fieldMap"] = field_map

        save_settings(settings)
        print("\n[SUCCESS] Form provisioned and config/settings.json updated!")
        print(f"Form URL: https://form.jotform.com/{form_id}")
    else:
        print("\n[DRY RUN COMPLETE] No changes were written.")


if __name__ == "__main__":
    main()
