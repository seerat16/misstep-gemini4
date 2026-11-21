# MedPrep Live Demo — Pre-Flight Checklist

## Physical Table & Rig
- [ ] **Overhead camera** mounted straight down over the white paper/tablecloth mat (1280×720+ webcam or phone via DroidCam/Camo).
- [ ] **Even, bright lighting** with minimal glare on the clear/bright AM pill organizer lids.
- [ ] **Props laid out:** 7-day AM/PM pill organizer, cup of BLUE candies, cup of RED candies, hand-sanitizer bottle, pen, printed `Initials` log sheet, 3 printed copies of `demo/medprep_card.md`.
- [ ] **Audio:** External speaker connected and unmuted (test browser audio + `gemini-3.8-flash-tts`).
- [ ] **Two browser tabs open:**
  - Tab 1: `http://localhost:3000/static/live.html`
  - Tab 2: `http://localhost:3000/static/report.html`

## 5 Practice Runs (Before Freezing Live Config)
- [ ] **Run 1 (Perfect):** Follow Steps 1–7 cleanly. Verify **0 alerts**, all 7 steps **green**, and Finish organizer check = **ALL COMPARTMENTS VERIFIED MATCHING**.
- [ ] **Run 2 (Skip Step 1):** Skip hand sanitizer and open MON–THU lids (Step 3). Verify spoken alert fires within **2 ticks (~4 s)** and Step 1 turns **red (SKIPPED)**.
- [ ] **Run 3 (Wrong Blue Count):** Put **3 BLUE** tablets in `TUE (AM)`. Hold open organizer under camera at Finish; verify **MISMATCH** is caught by `ultra_high` Decisions + Carbon.
- [ ] **Run 4 (Wrong Red Placement):** Put **1 RED** tablet in `TUE (AM)` (card says MON and WED only). Verify Finish catches the TUE RED `1` vs expected `0`.
- [ ] **Run 5 (Order Violation):** Close all four lids (Step 6) before putting in RED tablets (Step 5), or write initials (Step 7) early. Verify order/skip alert fires and Finish catches missing RED tablets.
- [ ] **Latency check:** Confirm median tick latency in Finish report is **< 1,500 ms**.

## 1-Minute Backup Video (Wi-Fi Insurance)
- [ ] Record screen + room audio of **1 clean run** and **1 mistake run** (skip Step 1 + 3 blue tablets in TUE) in ~60 seconds.
- [ ] Keep the **Record 60s & Analyze / Upload Video** fallback ready on `live.html` in case live ticks experience venue Wi-Fi jitter.
