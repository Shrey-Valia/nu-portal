---
description: Build or refresh your NU Portal profile (me/) from your resume, LinkedIn PDF, and a short interview
---

You are onboarding the user into NU Portal. Your job is to build an accurate, rich picture of them in the `me/` folder so NU Portal can pick jobs for them and write in their voice. Accuracy matters more than polish: everything you write may end up in a cover letter.

## Rules
- Never read, write, or ask about the contents of `me/private.yaml` (birthday, address, EEO answers). Tell the user to fill it in themselves from `templates/me/private.example.yaml`. Never ask for SSN, passwords, or government ID numbers.
- Only record facts the user's documents or answers support. If something is unclear, ask; don't guess.
- Keep ids lowercase-with-dashes and unique across the profile (skills, experiences, bullets, awards, extras).

## Steps
1. Read what exists: `me/resume.pdf` (required; if missing, ask the user to save it there and stop), `me/linkedin.pdf` (optional), anything in `me/samples/`, and any existing `me/profile.yaml`, `me/stories.md`, `me/voice.md`, `me/answers.yaml`. Use the templates in `templates/me/` for structure.
2. Draft `me/profile.yaml` from the documents: identity (name, email, phone, city, links), education (majors, minors, grad date, GPA, college), every experience/project with its bullets, skills with a level and evidence ids pointing at experiences, awards, extras (languages, interests).
3. Interview the user to fill gaps. Use the AskUserQuestion tool in small batches (2-4 questions at a time) and prefer multiple-choice options where sensible. Cover:
   - co-op cycle (e.g. Spring 2027) and co-op number; class level
   - work authorization: authorized in the US? need sponsorship now or later? U.S. citizen (only used to skip citizenship-only postings)? open to clearance?
   - target roles (3-6), domains/industries they care about, locations, onsite/hybrid/remote, relocation, minimum hourly pay
   - companies they love or want to avoid; keywords that mean "not for me"; dealbreakers
   - for their 3-6 strongest experiences: what they actually did, numbers/results they can stand behind, what they're proud of. Turn these into STAR stories in `me/stories.md` (`## [story:id] Title`).
   - how they like to sound: show a 3-sentence sample in two styles and ask which is closer; capture rules in `me/voice.md` (and anything learned from `me/samples/`).
4. Write `me/answers.yaml` with their answers to common application questions (sponsorship, authorization, start date, co-op duration, relocation, in-person, how they heard). Confirm each answer with them.
5. Copy `templates/me/preferences.example.md` to `me/preferences.md` if missing, replacing the examples with anything they told you about preferences.
6. Run `npm run profile:check` and show the user the output. Fix anything wrong, then summarize what NU Portal now knows and list remaining gaps.
7. Offer to test the writing pipeline: ask them to paste a real posting into a temp file and run `npm run letter:sample -- --file <file> --employer "<Company>" --title "<Title>"`.
