# Hack Western prize plan

Build the first demo around one question a visitor actually asks at Hack Western, such as “How do I get from check-in to the hardware lab?” Pick a real, approved stretch with a recognizable turn. The first milestone is an organizer uploading that scan and a guest opening its unlisted link on a second phone. Then add one Gemini-generated cue that helps the guest recognize where to turn.

Devpost lists 16 award categories, including first, second and third overall. Aim the same end-to-end walk at the overall judging criteria and the two tracks below. The next most natural entry is PCBWay if the printed mount produces the scan used in the demo. [Official prize list](https://hack-western-13.devpost.com/#prizes)

## Two primary tracks

| Priority | Who builds what | What to put in front of a judge |
| --- | --- | --- |
| 1. Organizers Choice — Most Adventurous | Krishna and Anish capture the stretch. Sam serves the scan. Arielle makes a turn or destination easy to recognize on a phone. | Give a first-time visitor the shared link and a destination. Let them choose the turn. Record how many visitors reached the destination, how many tried, and where they needed help. The award recognizes projects that help people discover unfamiliar places. |
| 2. MLH Best Use of Gemini API | Krishna and Anish supply a venue image that the team has permission to process and its position on the route. Sam sends it to Gemini and saves the candidate. Arielle shows the evidence, organizer approval, and resulting guest cue. | Show the source image beside the real model response. Ask for the visible text, landmark type, and a short cue, allowing an empty result for an unreadable sign. An organizer pins the cue to a verified waypoint. Show it in the shared scene. Record suggested, accepted, corrected, and rejected counts. |

The overall judges assess creativity, technical complexity, completeness, and design. One actual scan, a recognizable landmark, and a judge who can use the result on their own phone demonstrate all four. Google supports image inputs and schema-constrained JSON for this workflow. [Hack Western prize descriptions and judging criteria](https://hack-western-13.devpost.com/) · [Gemini image inputs](https://ai.google.dev/gemini-api/docs/image-understanding) · [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)

## A 90-second table demo

| Time | Action |
| --- | --- |
| 0–15 s | Show the unfamiliar turn and the phone that captured it. Give the judge a specific destination. |
| 15–35 s | Upload the real scan, select **Unlisted**, and open the resulting link on a guest phone. Keep an already-uploaded copy available for a slow venue connection. |
| 35–60 s | Show one actual Gemini suggestion with its source image. Approve or correct it. Refresh the guest view so the judge can see that exact cue. |
| 60–80 s | Give the phone to the judge to pick the turn or identify the destination in 3D. Show a short recorded walk if the hallway is away from the judging table. |
| 80–90 s | Report the measured visitor and landmark results with their sample sizes. Identify any replayed step. |

## Additional tracks when the work earns them

- **PCBWay hardware prototype.** Krishna and Anish can enter if they fabricate the wearable, scan the same stretch while wearing it, and show a design change they would fabricate next. Bring the actual mount and its resulting scan. A lens obstruction, tilt, or attachment problem from the first test gives the redesign a concrete purpose.
- **MLH Best Use of Auth0.** If Sam chooses Auth0 for private sharing, use an Auth0 API for real sign-in. Demonstrate the same private scan opening for an invited account and denying another account access to its raw asset. Finish the unlisted guest flow first.
- **MLH Best Use of Entire.** If the team adopts Entire, checkpoint one Claude or Codex task in Sessions and have a second teammate use the checkpoint and Graph to continue it. Keep the code change, tests, and actual token counts from comparable runs. Report a percentage only with a measured baseline and denominator.
- **MLH Best Use of Vultr.** If Sam chooses Vultr to run scan processing or host the shared viewer, show an actual phone upload passing through that deployment and the guest opening the result. Time the upload-to-view flow on the venue network. This is worth considering while hosting is still open.

These are independent entry decisions. Each sponsor describes its own expectations. [Official track descriptions](https://hack-western-13.devpost.com/)

## Remaining prize categories

| Award | Fit with this weekend’s build |
| --- | --- |
| Best Health Hack by Sun Life | A clinic-wayfinding version could fit if the team can demonstrate a specific patient problem and impact. The current demo is event discovery. |
| Best Use of QNX | The sponsor calls for a working QNX system with one of its open-source AI modules. The team has chosen phone capture. |
| The Canada Life Future Me Challenge | The challenge concerns young adults’ financial futures. It would require a separate product direction. |
| Hire Your First AI Employee by TinyFish | A fit would require a meaningful browser job running end to end on live sites using TinyFish, plus a public demo post tagging the sponsor. The current capture workflow runs on the phone. |
| MLH Best Use of Solana | The navigation and scan-sharing flows have no on-chain transaction requirement. |
| MLH Best Use of Tiger Data | Consider it if timestamped capture quality becomes a real feature, such as helping a mapper identify sections to rescan. Basic scan metadata alone offers little to demonstrate. |
| MLH Best Domain Name from GoDaddy Registry | Consider it if the team already wants to register a memorable share domain through GoDaddy Registry. |

The hardware, auth, agent workflow and hosting decisions above overlap existing team responsibilities. Invest extra time in these other categories only if there is a feature a visitor or mapper would use during the demo. [Sponsor descriptions](https://hack-western-13.devpost.com/#prizes)

## Submission

Add all four members to the Devpost project, explain what you built and why, and select the sponsor tracks you demonstrated. Expo judging includes organizers and representatives for selected sponsor tracks. The Devpost schedule closes **Sunday, November 22, 2026 at 9 a.m. Toronto time**. The rules agree on the hacking cutoff but contain a conflicting November 23 submission line. Use November 22 as the team deadline and check the organizer Slack for final judging instructions. [Devpost schedule](https://hack-western-13.devpost.com/details/dates) · [Rules and judging](https://hack-western-13.devpost.com/rules) · [Submission requirements](https://hack-western-13.devpost.com/)
