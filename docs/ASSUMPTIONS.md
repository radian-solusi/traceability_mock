# Assumptions

The mock follows these documents, newest first:

1. *Functional and Non Functional Requirement* (FR-001 … FR-016, NFR, station table, scanner tag table, tagging master data)
2. *Traceability System Requirement Rev 1* (operational requirements, actors, UC-001 … UC-005)
3. *Traceability Application 7061*, rev. 1.0 of 27/10/2026 (scope of work, core modules, PLC and camera table, topology)
4. The RFQ and the VDIS deck *Application Traceability Project 7061* (topology, PLC devices, dashboard mockups)

Anything these documents do not state is an assumption. Each one has a number so it can be confirmed or corrected with PTCT. Where the documents disagree with each other, the point is listed in section X.

Status:

- **Confirmed**: stated in the latest documents.
- **Open**: needs PTCT confirmation.
- **Mock only**: applies to the mock and is replaced by the real system.

[REQUIREMENTS-TRACE.md](REQUIREMENTS-TRACE.md) maps every requirement to the screen that shows it.

## A. Process and routing

| # | Assumption | Basis | Status |
|---|---|---|---|
| A1 | The HT finishing line route is **Limab → SEA (East *or* West) → EMI prove-up (only after an NC at SEA) → WMS → Hydrotest (Yamasui *or* Brandt) → PAUT → Finish HT Cold**. | FR station table order HT-01 … HT-07 and the plant-layout slide. The 7061 text lists WMS before EMI prove-up (X1). | Open |
| A2 | SEA East / West and Hydrotest Yamasui / Brandt are **parallel alternatives**: a pipe visits one of each pair. It is queued for the one with the shorter queue. | Two coils / two test benches with the same process. | Open |
| A3 | **EMI prove-up is a conditional step**: only pipes with an NC at SEA go there. | Prove-up verifies SEA / EMI indications. The FR table calls the station “EMI” (X10). | Open |
| A4 | An **NC at a station without a following prove-up step** puts the pipe **on hold**. The supervisor releases it (NC becomes Good under concession), sends it back for re-inspection, or rejects it. The decision is audited and reported to CTMS through CT-Track. | Rev 1: the supervisor monitors production and exceptions. No NC process is described. | Open |
| A5 | **Reject** comes from the Limab status flag or a supervisor decision; it removes the pipe from the line and counts as processed for work-order completion. Production points record Good / NC only. | Rev 1 §1.1 (Good / NC); FR-005 (Reject flag at Limab). | Confirmed (Good / NC), Open (rest) |
| A6 | Route changes are saved as **new versions** that apply to work orders released afterwards. | Rev 1 req. 10 “configuration process definitions”. Versioning not stated. | Open |
| A7 | A **work order is valid** when every pipe of its quantity is finished or rejected. | Mockup KPI “seluruh pipa telah diproses”. | Open |
| A8 | **Cycle time** = first record at Limab to the final result at PAUT, averaged over pipes finished in the last 24 h. | Mockup KPI. | Open |
| A9 | Shifts are 07:00–15:00, 15:00–23:00, 23:00–07:00; times in the browser's local time (WIB in Batam). | Not stated. | Open |
| A10 | The **Threading line** is listed as planned with no process points. Lines are configured, not coded. | 7061 objective “tracking across heat treatment and threading”; Rev 1 req. 9. | Open |

## B. Identification and movements

| # | Assumption | Basis | Status |
|---|---|---|---|
| B1 | **Limab IN comes from the DMC API**: when the robot prints the Data Matrix, the pipe is known and recorded at Limab (method AUTO, source DMC). | FR-005, UC-001. | Confirmed |
| B2 | **Limab OUT is recorded by the out-station sensor**, with the identity taken from the DMC sequence (head of the Limab sequence, method AUTO). The operator sets the status flag before the pipe leaves; it is applied when the sensor fires. If the pipe leaves without a flag, a flag task opens. If the sensors miss the pipe, the operator records the movement manually. | FR-003 “pipe unique number record from PLC sensor trigger”; FR-005; 7061 Limab note. Flag-before-move and the fallbacks are assumptions. | Open |
| B3 | **Left position** (sensor `HT-LM-LFT-01`, name assumed) = continue to the next station. **Right position** (`HT-LM-OUT-01`) = out station: the pipe leaves the line and waits for a supervisor decision. A Reject flag removes it in either direction. | FR-005 and the tag table name only the right sensor (X7, X9). | Open |
| B4 | **EMI prove-up has no scanner**: the operator records IN and OUT (UC-003 4b). | No scanner for EMI in the FR tag table or the PLC table. | Confirmed by omission |
| B5 | Each scanner station has **two read points**: entry (sensor `HT-xx-IN-01`, PLC message 10, movement IN) and exit (`HT-xx-OUT-01`, message 20, movement OUT). Sensor names other than `HT-LM-OUT-01` are assumed. | Topology “10 – Start Record, 20 – Stop Record”. If there is one read position per station, OUT can come from the exit sensor plus the sequence without changing the model. | Open |
| B6 | Identification fails in four ways, all handled by the operator (UC-003): **DMC unreadable**, **DMC not found in CTMS / master data**, **duplicate DMC** (already recorded at another station), and **pipe not expected at this station** (route check, added). | FR-006 lists the first three plus CTMS not responding. | Confirmed (FR-006), Open (route check) |
| B7 | The **suggestion** is the pipe sequence of the process point: the queue in expected order for IN, the pipes at the station (oldest first) for OUT. Queued pipes of the parallel station are offered too. | UC-003 step 2 “retrieves pipe sequence data based on the production line and process point”. | Confirmed |
| B8 | The operator can **dismiss** an event that had no pipe (false trigger, or a duplicate DMC not at this station). Dismissed events stay in the log. | Not stated. | Open |
| B9 | **DMC content format** in the mock: work order + 3-digit pipe number, e.g. `WHT26120-009`. The documents only say the DMC is the pipe's unique number from the Limab robot (FR-005). | Not stated; the real content comes from the robot / DMC database. | Open |
| B10 | **Reading paths**: option 1 (main) = scanner → PLC → Kepware OPC → application; option 2 (redundancy) = the application reads the scanner directly. The station switches to option 2 automatically while the PLC / OPC path is down and back when it returns; it can also be forced per station. | FR-001 (X2 for the deck's different description). Switching details assumed. | Confirmed (paths), Open (switching) |
| B11 | **Scanner to station mapping**: `HT-W1-SCN-01` SEA East, `HT-W2-SCN-01` SEA West, `HT-M1-SCN-01` WMS, `HT-M2-SCN-01` Hydrotest Yamasui, `HT-E1-SCN-01` Hydrotest Brandt, `HT-E2-SCN-01` PAUT. | The tag table gives the names and West / Middle / East zones, not the stations. | Open |
| B12 | **Existing transaction** (UC-002 3a): a read for the same pipe, process point and movement updates the existing record while the pipe is still at that point (IN), or until it has moved on (OUT). The record shows **UPDATED ×n**. | UC-002 step 3 / 3a; “event” read as the movement type. | Open |
| B13 | **Camera store-and-forward**: while the network to the application is down, the camera keeps its reads; when the link returns they are processed in order with their original time (source *buffer*). If store-and-forward is switched off, the reads are lost and an alarm is raised. | NFR redundancy. | Confirmed (behaviour), Open (details) |
| B14 | **Autofocus** is run by the operator from the station display when the pipe size changes. The mock models it as focus distance per pipe OD and a read margin; a scanner aligned for another size misses reads until re-focused. | FR-001.3; 7061 scope. The Keyence SDK interface is not known yet. | Open |
| B15 | When a scanner is **offline**, the station display offers manual entry for every movement. | Not stated. | Open |

## C. Results and status

| # | Assumption | Basis | Status |
|---|---|---|---|
| C1 | **Production points** record **Good / NC**. The **Limab status flag** is **Good / NC / Reject / Pending**. A pipe without a result is **Pending**. Dashboard colours: Good blue, NC yellow, Reject red, Pending grey; the physical marking is no colour, yellow, red, grey / blue line. | Rev 1 §1.1, FR-005, mockup legend (X3, X8). | Confirmed |
| C2 | A result is required **at OUT at every production point**, including WMS. It stays a per-station setting. | Rev 1 §1.1 “at each production point”; UC-002 step 6. | Confirmed |
| C3 | NC (and Reject at Limab) requires a **defect code**. The codes (EM01, HY02, UT04, MK02 …) are placeholders. | Not stated; PTCT to supply the code list per process. | Open |
| C4 | The result form shows **machine data from the station PLC** (pressure, hold time, max indication …) with invented values. | Not stated; shows where PLC data could prefill the form. | Open |
| C5 | **Manual correction** of a result or flag (FR-015) is done by a supervisor or admin from the pipe trace, only while the pipe has not moved since and no supervisor decision was taken on it. The pipe is re-routed from that station, the correction is sent to CTMS, and the audit trail keeps before and after values with the reason. | FR-015 names manual corrections; the rules are assumed. | Open |

## D. Integrations

| # | Assumption | Basis | Status |
|---|---|---|---|
| D1 | The **DMC API pushes batches** per work order (6 pipes in the mock). A DMC that is already registered is **rejected from the batch** and raised as a duplicate DMC exception. | UC-001, FR-006. Batch size and push / pull mode not stated. | Open |
| D2 | **CTMS submission is asynchronous**: the result is saved first, then sent; status PENDING → SUCCESS / FAILED. | UC-005. | Confirmed |
| D3 | Every CTMS message goes **through CT-Track** (REST JSON, JWT) with the transaction id as idempotency key. Failures retry automatically (10 s, 30 s, 60 s by default) and then wait for a manual retry. Timeout and retries are system parameters. | FR-010, NFR network. Values assumed. | Confirmed (CT-Track), Open (values) |
| D4 | Messages to CTMS: inspection results, Limab status flags, supervisor decisions and corrections. Plain movements are published to CT-Track as movement information but are not CTMS submissions. | UC-005 1a, FR-003, FR-007. Decisions and corrections assumed. | Open |
| D5 | Work orders and pipe information come from CTMS through CT-Track; released work orders without marked pipes are listed. | FR-005, FR-010. | Confirmed |
| D6 | **Tag names**: scanner tags use the FR tag table names (`HT-W1-SCN-01.ReadCode` …) and the Limab right sensor `HT-LM-OUT-01`. Kepware item names replace hyphens with underscores. PLC addresses, other sensor names and the PLC tag items are invented. | FR tag table; the rest is defined during PLC programming. | Confirmed (names), Mock only (rest) |
| D7 | Hostnames (`ptct-dtas01`, `ptct-opc01`, `ptct-cttrack01`, `ctms-app01` …) are placeholders. | Topology IPs are partly unreadable. | Mock only |
| D8 | The UI talks to DTAS over HTTPS 443; the REST API listens on port 3000 as in the RFQ. Both are environment settings. | RFQ (3000) vs topology (443). | Open |
| D9 | CT-Track endpoints in the API contract are placeholders for the integration workshop. | FR-010 “L1 API Server provided by PTCT” (X4). | Open |
| D10 | **Reconciliation** compares each pipe's latest tracking status with the value CTMS holds, and the CTMS work-order quantity with the pipes marked. It runs on every full sync (scheduled, and *Full sync now*). Differences can be re-sent or marked as reviewed with a note. | Rev 1 req. 8, FR-010 acceptance “matching with data from CTMS or L3”. | Open |
| D11 | **Alarm criteria** (scanner offline, option 2 active, 3 consecutive read failures, DMC not found, duplicate DMC, CTMS not responding, camera storing reads, dwell over 25 min, reconciliation differences) are placeholders, editable in System parameters. | FR-014 “alert criteria will be defined with the process owner”. | Open |

## E. Users and security

| # | Assumption | Basis | Status |
|---|---|---|---|
| E1 | Four roles from the Rev 1 actors: **Administrator, Supervisor, Operator, Reporting user**, resolved from AD groups (`PTCT-TRC-Admins`, `-Supervisors`, `-Operators`, `-Reporting`). Group names are placeholders. | Rev 1 actors; FR-004. | Confirmed (roles), Open (groups) |
| E2 | Operators are assigned to specific process points; supervisors and admins can open every station; reporting users have no station display. | Not stated. | Open |
| E3 | **Station PCs are bound to a process point** by hostname, and each carries the Windows user used for **single sign-on**: *Windows sign-in* on `OPS-LIMAB-01` signs in the Limab operator without a password. | FR-004 single sign-on. Binding and SSO mapping assumed. | Open |
| E4 | The permission matrix (view / edit per module and role) is an assumption and can be changed on the User access screen. | Not stated. | Open |
| E5 | Session = JWT, 8 h, 30 min idle lock on station displays (policy text only). | Not stated. | Mock only |
| E6 | The mock accepts any password for the listed accounts; the password is never stored, as required. | FR-004. | Mock only |

## F. User interface

| # | Assumption | Basis | Status |
|---|---|---|---|
| F1 | Product name **PipeTrack** and the three main pages: each station, operator view, supervisor view. | 7061 dashboard section. | Confirmed |
| F2 | The UI is in **English**; Indonesian labels from the mockup are translated. Webix has a Bahasa Indonesia locale if needed. | Not stated. | Open |
| F3 | The **PT Citra Tubindo Tbk · Vallourec Group** logo (supplied by Radian) is used in the navigation, the login page and the browser tab; PipeTrack stays the application name. | Logo provided by the user on 2026-10-30. | Confirmed |
| F4 | Targets: Microsoft Edge on Windows 11, 24" touch station displays, supervisor desktops, a wall TV. Tablets work; phones are not a target. | RFQ, 7061. | Open |
| F5 | The HT plant layout is a **schematic**, not a scaled drawing. | Plant-layout slide. | Open |
| F6 | Use-case numbers follow Rev 1 (UC-001 … UC-005); the older numbering from the first use-case screenshots is retired. | Rev 1. | Confirmed |
| F7 | **Export format.** The *Export* button on each table writes a **CSV file, comma-delimited** (RFC 4180: fields with a comma, a quote or a line break are quoted; UTF-8 with BOM; CRLF line ends). It holds the visible columns and rows with the current sort and filter, without the button columns. The *JSON* button in Reports writes the data extraction with the filters used. | The mockups show *Export* on every table, and Rev 1 requirement 12 asks for data extraction for analysis; no file format is named. | Open |

## G. Technology

| # | Assumption | Basis | Status |
|---|---|---|---|
| G1 | **Webix 11.4 Standard (GPL v3)** from npm. If the delivered application is not GPL, a commercial Webix licence is needed. | RFQ names Webix; edition not stated. | Open |
| G2 | **Vite** builds static files that Apache on DTAS can serve. | RFQ allows Vite or Webpack. | Open |
| G3 | The mock keeps data **in memory** and re-seeds on reload. The real system uses PostgreSQL 18 (users, wo, records, logs, plus configuration). | RFQ. | Mock only |
| G4 | Backend choice (PHP CodeIgniter 3+ or Go) is open; the rules in `src/core/traceability.js` can be ported to either. | RFQ. | Open |

## X. Points where the documents disagree or are silent

| # | Point | What the mock does |
|---|---|---|
| X1 | **EMI / WMS order**: the FR station table has HT-03 EMI before HT-04 WMS; the 7061 text lists “SEA East, SEA West, WMS, EMI Prove-up …”. | EMI prove-up after SEA (conditional), then WMS. |
| X2 | **Reading options**: FR-001 makes the PLC → Kepware path option 1 and the direct camera read option 2. The deck topology described option 1 as camera → WebSocket → CT-Track server and option 2 as camera → PLC. | Follows FR-001 (newer). |
| X3 | **Good colour**: the physical marking for Good is *no colour* (FR-005); the dashboard legend uses blue for Good. | Blue on screens; the Limab flag buttons show the physical marking. |
| X4 | **CT-Track ownership**: FR-010 says the L1 API server is provided by PTCT; the topology puts the CT-Track server in the vendor scope. | Treated as PTCT's; the API contract is a proposal. |
| X5 | **Kepware licences**: the RFQ lists drivers for Siemens, Allen-Bradley, Schneider Electric and Mitsubishi; 7061 asks for perpetual Connectivity, Siemens and Allen-Bradley suites registered to PTCT. No Mitsubishi device is listed. | OPC page shows the 7061 licences. |
| X6 | **FR-016 “Data Integration Detail”** has no content. | API contract tab holds the proposed shapes. |
| X7 | **Limab right position = out station**: not said whether the pipe can come back. | Held for a supervisor decision (release, re-inspect, reject). |
| X8 | **Pending marking** is “Gray / Blue” (FR-005) while blue is Good on the dashboards. | Grey on screens. |
| X9 | **Limab sensors**: only the right sensor `HT-LM-OUT-01` is in the tag table; Limab is not in the PLC table. | Left sensor `HT-LM-LFT-01` and device `LIMAB_PLC` assumed. |
| X10 | **Station naming**: “EMI” (FR table) vs “EMI Prove-up” (7061, RFQ). | One station, HT-03 EMI Prove-up. |
