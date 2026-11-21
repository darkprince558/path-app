# Hack Western development roadmap

**First release goal**

An organizer uploads a real venue scan as **Unlisted**. Someone on a second phone opens the link while signed out, rotates the scene, and recognizes the turn.

Use one ordinary phone video for the first capture handoff. The [offline website product plan](offline-web-product.md) sequences the real 3D trial, offline recording, delayed upload, live preview and accessible guest directions.

[Edit this roadmap on GitHub](https://github.com/darkprince558/path-app/edit/main/planning/ROADMAP.md) · [Live team board and checkpoints](https://github.com/darkprince558/path-app/issues/8)

## Pick up work

The viewer, API, and capture trial can start in parallel. Claim your issue with your name, branch, and writable paths. Use the issue for daily status and blockers. Update the milestone checkbox here when the team can reproduce the result.

| Owner | First task | What the next person receives |
| --- | --- | --- |
| Arielle | [Render the guest scan, #2](https://github.com/darkprince558/path-app/issues/2) | A browser view that opens the synthetic scan from its share URL and shows the junction. |
| Sam | [Persist uploads and enforce sharing, #3](https://github.com/darkprince558/path-app/issues/3) | A stable share URL and an example metadata response for Arielle. Verify it after restarting the API. |
| Krishna + Anish | [Capture one real turn, #4](https://github.com/darkprince558/path-app/issues/4) | A phone export, landmark frames, file size, axes and one measured distance. Coordinate on the issue before recording. |
| Anish + Arielle + Sam | [Run the second-phone trial, #5](https://github.com/darkprince558/path-app/issues/5) | Prepare the trial now. Once #2–4 and hosting are ready, record device, network, load time and whether the guest recognized the turn. |

## Milestones

- [x] **Local integration baseline.** The synthetic fixture and upload/share mock pass `make check`. The checks cover all three visibility modes, private grants and revocation. The team has retrieved a real Claude checkpoint from a fresh clone. [CI](https://github.com/darkprince558/path-app/actions/runs/44862071536) · [Entire setup](https://github.com/darkprince558/path-app/pull/6)
- [ ] **Share a real scan.** Connect #2–4, deploy the website and API, and complete #5 over cellular. Record the guest result on #5. Reopen the same URL after a restart and check that revoking a private viewer blocks the raw asset too. [Deployment plan](../docs/deployment.md)
- [ ] **Give a visitor one useful direction.** Capture a recognizable junction and connect a QR start to two destinations on verified walkable paths. Generate a Gemini landmark cue from the captured frames, let an organizer approve it, and ask a first-time visitor to follow it. Record the source frame, decision and observed turn. [Gemini demo](../docs/gemini-demo.md)
- [ ] **Publish a contribution.** Align one extra section to a known anchor. Open the guest event link before and after organizer approval and record which section appears. [Event architecture](../docs/architecture.md)
- [ ] **Rehearse and submit.** Keep a previously uploaded scan and a recording of a successful walkthrough for a slow venue connection. Identify replayed steps during the demo. Save the working commit and demonstrated tracks, then submit before **Sunday, November 22 at 9 a.m. Toronto time**. [Prize plan](../docs/prize-plan.md) · [Devpost schedule](https://hack-western-13.devpost.com/details/dates)

## Decisions at the next integration

| Decision | Owner and evidence |
| --- | --- |
| Which phone export should ship? | Krishna and Arielle try colored PLY first. If the landmark is hard to recognize or slow to render, compare a cropped PLY and textured GLB on the same phone. [Format trial](../docs/scan-formats.md) |
| Which service will host the demo? | Sam and Anish confirm host, storage, identity provider and budget before provisioning. Share a phone-accessible HTTPS URL for #5. |
| What gets demo time? | All four prioritize the upload-to-second-phone flow. If routing or contributions are unfinished, demonstrate the captured turn and any approved landmark that works. For Entire, keep a real handoff and measure the same lookup in two fresh sessions before reporting savings. |

Anyone on the team can propose a change with the GitHub edit link above. When a milestone passes, check its box and add the PR, device trial or demo evidence beside it. If the plan changes, update the next milestone, its owner and the issue that carries the work.
