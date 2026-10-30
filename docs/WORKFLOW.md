# End-to-end workflow

One pipe through the HT finishing line, and which screen each role uses at each step. The **Demo guide** screen runs the same 15 steps: *Run step* does the machine side and opens the screen, the second button does the operator part.

Use-case numbers follow *Traceability System Requirement Rev 1*; FR numbers follow *Functional and Non Functional Requirement*.

## The flow in one picture

```
CTMS work order ─▶ CT-Track ─▶ Limab robot prints the DMC ─▶ DMC API ─▶ Limab sequence (UC-001, FR-005)
                                                                        │
  Limab operator sets the status flag  Good · NC · Reject · Pending ────┤ (FR-003, FR-005)
  out-station sensor:  left = next station   right = out station (hold) │
                                                                        ▼
each production point:  entry sensor ─▶ Keyence scanner ─▶ option 1: PLC → Kepware OPC   (FR-001)
                                                     └──▶ option 2: direct read when the PLC path is down
                                                                        │
   barcode valid and pipe known? ── yes ─▶ existing record for this pipe, point and movement?
               │ no                              │ yes ─▶ update it (UC-002 3a)
               ▼                                 │ no  ─▶ record AUTO (UC-002)
   operator: confirm the suggestion from the pipe sequence, select another pipe (4a)
             or enter the identity (4b) ─▶ record MANUAL (UC-003)
                                                                        │
   OUT at a production point ─▶ operator enters Good / NC (UC-004) ─▶ saved
                                                                        │
   result ─▶ CT-Track ─▶ CTMS in the background: PENDING → SUCCESS / FAILED + retries (UC-005)
                                                                        │
   Good ─▶ next station        NC after SEA ─▶ EMI prove-up        NC elsewhere ─▶ supervisor hold
```

The application never talks to the IT layer directly: work orders, pipe information, movements and results all go through **CT-Track** (FR-010). A **reconciliation** compares what tracking holds with what CTMS holds (Rev 1 requirement 8).

## Step by step (demo guide)

| # | What happens | Who | Screen | Reference |
|---|---|---|---|---|
| 1 | CTMS releases a work order. The Limab robot prints a Data Matrix on each pipe and the DMC API sends the unique numbers; pipe information comes from CTMS through CT-Track. The pipes join the Limab sequence in DMC order. | System | Station display → Limab, Work orders & pipes | UC-001 |
| 2 | The Limab operator marks the pipe and sets its **status flag** (Good = no colour line). The flag is applied when the pipe leaves. | Operator (Limab) | Limab → status-flag panel | FR-005 |
| 3 | The pipe moves **left**. The out-station sensor records OUT with the identity from the sequence; the flag goes to CTMS through CT-Track. The pipe is queued for SEA East or West. | System | Limab, SEA station display (queue *from Limab*) | FR-003, FR-005 |
| 4 | At the SEA entry the scanner reads the Data Matrix through the PLC and Kepware (**option 1**): IN is recorded **AUTO** with the rolling start and read times. The scanner reads the same pipe again: the existing record is **updated**, not duplicated. | System | SEA → Last scan, Recent movements | UC-002, UC-002 3a, FR-007 |
| 5 | The exit read records OUT and opens the result form. The operator enters **NC · EM01**; after an NC at SEA the pipe goes to EMI prove-up. | Operator (SEA) | SEA → Operator action | UC-004 |
| 6 | EMI prove-up has no scanner. The operator records IN and OUT (method **MANUAL**) and enters **Good**. | Operator (EMI) | EMI Prove-up | UC-003 4b, UC-004 |
| 7 | At WMS the **DMC is unreadable**. The display suggests the next pipe in the WMS sequence; the operator selects the demo pipe or enters it, and confirms. | Operator (WMS) | WMS → Confirm pipe identity | UC-003, FR-006 |
| 8 | The **PLC / OPC path at WMS fails**. The application reads the scanner directly (**option 2**), the exit read is still AUTO, and the alarm *Reading switched to option 2* appears. The operator enters Good. | System, Operator | WMS (alarm banner, OPT 2 badge), Alarms | FR-001, FR-014 |
| 9 | At the hydrotest the **network to the application is down**. The camera stores the entry read and sends it, with its original time, when the link is back. | System | Hydrotest (stored reads in the header) | NFR redundancy |
| 10 | **CTMS is not responding**. The operator enters Good: the result is saved, the CTMS submission fails and retries, and the alarm *CTMS not responding* is raised. | Operator, System | Hydrotest, API synchronization | UC-005 3a, FR-006 |
| 11 | CTMS is back; the failed submissions are retried and turn **Success** with a CTMS reference. | Supervisor | API synchronization → CT-Track → CTMS | UC-005 |
| 12 | At PAUT the operator enters **NC · UT04**. No prove-up follows PAUT, so the pipe goes **on hold**. | Operator (PAUT) | PAUT | UC-004 |
| 13 | The supervisor **releases** the pipe after the re-scan. The decision is audited and sent to CTMS; the pipe reaches Finish HT Cold. | Supervisor | Supervisor view → Pipes to review | A4 |
| 14 | A **full sync** through CT-Track compares every pipe's latest status with CTMS and lists the differences. | Supervisor | API synchronization → Reconciliation | FR-010, Rev 1 req. 8 |
| 15 | The **pipe trace** shows the whole history: DMC marking, status flag, every IN / OUT with AUTO / MANUAL / UPDATED and reading path, operators, results, CTMS attempts, the hold and the decision. A supervisor can correct a result here while the pipe has not moved. | All roles | Pipe trace | FR-013, FR-015 |

## Watching the whole plant

- **Operations / tracking** (all roles): alarm banner, KPI tiles, the flow between stations, the Data Matrix reading status with rolling start and read times and the reading path, the queue per station and the tracking status of every pipe.
- **Supervisor view**: totals by status (Total processed, Good, NC, Pending, Reject), the *Stations* table (current pipe, queue, results, scanner and sensor status, open tasks, alarms per station), pipes to review, active alarms, open operator tasks, the pipe queue status table from the mockup, and charts.
- **HT plant layout**: the line with live pipe positions coloured by status, scanner zones, the Limab out-station rack, racks, and a card per station.
- **Alarms & exceptions**: alarms with acknowledge, the FR-006 exception list, and the alarm criteria.

Turn on **auto-simulation** (play icon in the header) to let the virtual plant run: new DMC batches, Limab flags and movements, scanner reads with failures, autofocus when the pipe size changes, virtual operators at the stations you are not looking at, supervisor decisions and CTMS responses. The station display you have open is left to you.

## Demo accounts

| Account | Role | Workstation | Lands on | Sees |
|---|---|---|---|---|
| `budi.santoso` | Operator | OPS-SEA-01 | SEA East station display | Dashboards, alarms, his stations (SEA East, SEA West, EMI prove-up), work orders, pipe trace |
| `siti.aminah` | Operator | OPS-LIMAB-01 (*Windows sign-in*) | Limab station display | Same, for Limab |
| `andi.pratama` | Supervisor | SUP-HT-01 | Supervisor view | Everything except parameters and user administration |
| `maria.tan` | Admin | SUP-HT-01 | Operations dashboard | Everything, including parameters, users and permissions |
| `dewi.lestari` | Reporting user | QA-RPT-01 | Reports | Dashboards, alarms, work orders, pipe trace, reports and data extraction |

Any password works. *Windows sign-in* uses the Windows user configured for the selected workstation (Parameters → Servers & desktops).

## Things to try on a station display

- **Simulator bar** (purple, dashed): make a pipe arrive or leave, read the same pipe again, force the next read to fail, or send a garbled code.
- **Faults…**: switch the scanner off, take the PLC / OPC path down (option 2), take the network down (the camera stores reads), or send a duplicate DMC.
- **Autofocus**: re-focus the scanner for the pipe size at the station.
- **Not in list? Enter identity**: type a DMC or pick any pipe that can be at this point.
- **Limab**: flag pipes in the sequence, then move them left or right; move a pipe without a flag to see the flag task; use *Record movement manually* when the sensors miss a pipe.
- Enter **NC** at SEA and watch the pipe go to EMI prove-up; enter **NC** at PAUT and watch it appear under *Pipes to review*.
