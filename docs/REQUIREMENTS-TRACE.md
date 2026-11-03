# Requirements trace

Where each requirement of the latest documents shows up in the mock.

- **FR / NFR**: *Functional and Non Functional Requirement*
- **Rev 1**: *Traceability System Requirement Rev 1* (operational requirements, actors, UC-001 … UC-005)
- **7061**: *Traceability Application 7061*, Technical Information and Requirement, rev. 1.0 (27/10/2026)

Status:

- **Shown**: the screen and the rule work in the mock.
- **Simulated**: the screen works, and the external side (PLC, scanner, CT-Track, CTMS, AD) is played by the simulator.
- **Placeholder**: the screen exists, but the content waits for PTCT input.

Assumption numbers refer to [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Functional requirements

| ID | Requirement | Where in the mock | Status |
|---|---|---|---|
| FR-001 | Tags stored in the OPC server; pipe unique number and activities recorded with timestamps; no duplicate number | OPC Kepware (live tags under the FR tag names), Parameters → PLC / sensor / camera tags, every movement record with its timestamps (Pipe trace, Reports → Pipe movement history). Duplicate numbers are refused (FR-006). | Simulated |
| FR-001 opt. 1 | Main path: PLC programmed for camera ON / OFF and the DMC reading signal | Scanner tags `Trigger`, `ReadCode`, `ReadStatus` per scanner; reads marked **OPT 1 · PLC** on the station display, the operations dashboard and the reading events | Simulated |
| FR-001 opt. 2 | Redundancy: the application reads the camera directly; switches to option 2 when option 1 is not available | Station display → **Faults… → PLC / OPC path down**: the reading switches to **OPT 2 · direct**, an alarm is raised, and it switches back when the path returns. It can also be forced per station (Keyence DMC readers → Reading path, Parameters → Stations). | Simulated |
| FR-001.3 | Keyence autofocus and alignment, run from the application | Station display → **Autofocus** (operator), Keyence DMC readers → Autofocus. A scanner aligned for another pipe size misses reads until it is re-focused. | Simulated |
| FR-002 | Process tagging of sensors and external connections | Sensor tags per station (entry / exit, Limab left / right), sensor status on the station display and the supervisor view | Simulated |
| FR-003 | Limab: record the pipe sequence leaving Limab with a flag status; pipe unique number recorded from the PLC sensor trigger; flag indicator on work order and pipe | Limab station display: sequence in DMC order, **status flag** per pipe, OUT recorded by the out-station sensor with the identity from the sequence (method AUTO). Flag column in Work orders & pipes, flag in the pipe trace and in Reports → Limab status flags. The flag goes to CTMS through CT-Track. | Shown |
| FR-004 | Authentication with Microsoft AD (LDAP / Kerberos), single sign-on, user information shown, no password stored | Login (username / password or **Windows sign-in**), user card (account, role, stations), User access → AD groups & session policy | Simulated |
| FR-005 | DMC unique number from the Limab robot; pipe information from CTMS via API; left = next station, right = out station; operator selects Good / NC / Reject / Pending | DMC batches (API synchronization → DMC inbound), Limab station display with the four flags and their physical marking (no colour, yellow, red, grey / blue line), simulator buttons *Pipe moves left / right*, manual movement popup | Shown |
| FR-006 | Exceptions: DMC unreadable, CTMS API not responding, duplicate DMC, DMC not found in CTMS | Station display tasks (UC-003), Alarms & exceptions → Exceptions, CTMS retries in API synchronization, duplicate DMC rejected from a robot batch (*Batch with a duplicate DMC*) or raised at a station (*Faults… → duplicate DMC*), Reports → Exceptions | Shown |
| FR-007 | Movement record with pipe start rolling time and DMC reading time; manual record when the read fails, from the incoming pipe list or a manual input popup; Good / NC quantities; movement information to CT-Track; real-time display | Last scan panel and reading tables show **Rolling start** and **DMC read** times; manual identification from the pipe sequence or by typing the DMC; counts per status on the supervisor view and reports; movements counted as published to CT-Track | Shown |
| FR-008 | CT-Track collects and sends data to CTMS | Every CTMS message is addressed to CT-Track (API synchronization → CT-Track → CTMS, payload window) | Simulated |
| FR-009 | Station display: current pipe, pipe queue, last scan, scanner status, sensor status, queue from the earlier station. Supervisor view: total processed, Good, NC, Pending, Reject | Station display (header with scanner and sensor status, *Last scan*, *Current pipe*, *Queue · from …*). Supervisor view (status tiles and the *Stations* table with the same columns per station) | Shown |
| FR-010 | JSON full or push sync with CT-Track; no direct connection to the IT layer; match the data with CTMS | API synchronization: CT-Track → CTMS queue, **Reconciliation** tab (full sync, per-pipe comparison, work-order quantities, resend, mark reviewed) | Simulated |
| FR-011 | Reports: status, quantity, NC, scanner readability, station performance | Reports → Traceability report, Station performance, Scanner readability (plus inspection results, Limab flags, history, manual identifications, exceptions, CTMS log); CSV export and JSON extraction | Shown |
| FR-012 | Master data: stations, DMC cameras, process tags | Parameters → Stations & processes, Lines & routes, PLC / sensor / camera tags (incl. tagging master data), Keyence DMC readers | Shown |
| FR-013 | Pipe history at each station | Pipe trace (genealogy and movement records), pipe detail window from any table | Shown |
| FR-014 | Alerts on the dashboard; criteria defined with the process owner | Alarm icon and banners, Alarms & exceptions page, active alarms on the supervisor view, criteria in Parameters → System parameters (placeholders, D11) | Placeholder |
| FR-015 | Audit trail: login, logout, status changes, manual corrections, configuration changes, with user, timestamp, before and after value | Audit trail page (category filter, before / after columns). Corrections from the pipe trace (supervisor). Configuration screens write before / after values. | Shown |
| FR-016 | Data integration detail | Empty in the document. The proposed shapes are on API synchronization → API contract. | Placeholder |

## Non-functional requirements

| Area | Requirement | In the mock |
|---|---|---|
| Performance | Dashboard response under 3 s | Screens refresh from the in-memory data within about 0.5 s of each event. The target is a system parameter. |
| Availability | Uptime 99.5 % | System parameter (display only). |
| Database | At least 5 years of history | System parameter. The mock keeps about 30 hours. |
| Security | LDAP / AD authentication, audit trail | FR-004 and FR-015 above. |
| Backup | Automatic daily backup | System parameter (on / off and time). |
| Scalability | Add new stations without major code changes | Parameters → Add process point: the station gets its display, menu entry, dashboard tiles, route position and generated tags without code. |
| Network | API timeout, retry mechanism | System parameters (timeout, retry intervals, automatic retries), used by the CTMS queue. |
| Logging | Error logging and activity log | Audit trail, exceptions, alarms, CTMS attempt history per message. |
| Redundancy, camera reading | The camera stores reads while the system is down and sends them when it resumes | Station display → **Faults… → Network down**: reads are stored in the camera and delivered with their original time when the link returns (also step 9 of the demo guide). Can be switched off in System parameters to show what happens without it. |
| NFR tagging | PLC tagging per process from the Keyence cameras, sensors and external connections | FR-001 / FR-002 above. |

## Rev 1 operational requirements

| # | Requirement | In the mock |
|---|---|---|
| 1 | Traceability of pipe movement across production points | IN / OUT per station, Pipe trace, plant layout |
| 2 | Identify pipes with barcode / camera readers | Keyence scanners, option 1 and option 2 |
| 3 | Manual identification when automatic reading fails / re-entry | UC-003 on the station display; re-reads update the existing record |
| 4 | Record pipe out from production point | OUT movements; Limab out-station by sensor |
| 5 | DMC as the base pipe data | DMC API batches, DMC on every record |
| 6 | Inspection result from the operator | Good / NC form at each production point |
| 7 | Send inspection results to CTMS | UC-005 via CT-Track |
| 8 | Compare tracking data with CTMS data | API synchronization → Reconciliation |
| 9 | Multiple production lines through configuration | Parameters → Lines & routes (HT active, Threading planned, *Add line*) |
| 10 | Configurable process definitions | Stations & processes, routes with versions |
| 11 | Reporting and dashboards | Dashboards and Reports |
| 12 | Data extraction for analysis | CSV on every table, JSON extraction in Reports |

## Rev 1 actors

| Actor | In the mock |
|---|---|
| Traceability System | The domain rules in `src/core` |
| Operator | `budi.santoso` (SEA / EMI), `siti.aminah` (Limab) and others: station displays only for their process points |
| CTMS | Simulated behind CT-Track; responses Success / Failed |
| Supervisor | `andi.pratama`: monitoring, alarms, held pipes, corrections, CTMS retries |
| Administrator | `maria.tan`: lines, process points, tags, users, system parameters |
| Reporting User | `dewi.lestari`: dashboards, work orders, pipe trace, reports and extraction; no station display |

## Rev 1 use cases

| Use case | Step / extension | In the mock |
|---|---|---|
| UC-001 Manage barcode pipe master data | DMC API sends the robot's barcodes | API synchronization → DMC inbound, Limab sequence |
| UC-002 Identify pipe and record movement | 1–2 validate barcode, identify pipe | Scanner read → identification **AUTO** |
| | 3–4 existing transaction for the same pipe, process point and event | Checked on every read |
| | 3a existing transaction found → update it | **UPDATED** badge and ×n counter (station display *Re-read*, step 4 of the guide) |
| | 5 record with method AUTO | Movement records |
| | 6–7 inspection result required → UC-004 | Result task after OUT |
| | 2a invalid barcode → UC-003, then the existing-transaction check | Identification task on the station display |
| UC-003 Resolve pipe identity manually | 1–3 detect unreadable barcode, retrieve the pipe sequence, show the suggestion | Suggested pipe on top of the list (*Next in sequence*) |
| | 4 confirm the suggestion | *Confirm selected pipe* |
| | 4a select another pipe | Pick another pipe in the list |
| | 4b enter the identity manually | *Not in list? Enter identity*; *Manual entry* for stations without a scanner |
| | 6 recorded as MANUAL | Movement records, reports |
| UC-004 Record pipe inspection result | Good / NC saved with the transaction | Result form; NC needs a defect code (C3) |
| UC-005 Submit inspection result to CTMS and track status | 1–4 send, Success | CTMS status per record, API synchronization |
| | 1a no result → not sent | Plain movements show “–” |
| | 3a Failed response → status Failed | Failed status, automatic retries, manual retry (step 10–11 of the guide) |

## 7061 scope of work

| Scope item | In the mock |
|---|---|
| Integration of PLC signals (fig. 8), Kepware, CTMS via API, user access and logs, pipe entry time from the PLC trigger | OPC Kepware, API synchronization, User access, Audit trail, rolling start time |
| PLC tagging per station into Kepware | Parameters → tags, OPC Kepware |
| Web dashboards and pipe tracking (fig. 3 and 5) for Limab, SEA East / West, WMS, EMI prove-up, Hydrotest Yamasui / Brandt, PAUT | Operations / tracking, Supervisor view, HT plant layout, one station display per station |
| “PipeTrack consists of 3 main pages: each station, operator view, supervisor view” | Station display, Operations / tracking, Supervisor view |
| Keyence autofocus from the application, by the operator when the pipe size changes | Station display → Autofocus |
| Limab: operators mark the pipe status; out-station record from Limab | Limab station display |
| Core modules: Dashboard, Parameter, Work order pipe information, Report, User access, API synchronization, OPC Kepware, Keyence autofocus DMC reader | One menu entry each |
| Data integration from OT to IT through JSON API (fig. 7) | CT-Track → CTMS |
| Real-time tracking across heat treatment **and threading** (objective) | Threading line listed as *planned* in Lines & routes; no process points yet (A10) |

## Tagging master data

TRC-001 … TRC-007 are listed in the app under **Parameters → PLC / sensor / camera tags → Tagging master data**, each with the screen that covers it.
