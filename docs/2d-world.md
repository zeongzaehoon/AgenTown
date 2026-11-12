# AgenTown 2D world language

The current form-and-list interface is a functional proof of concept. It proves
product state, execution, recovery and desktop packaging, but it is not the
target AgenTown experience. The target is a legible company world in which real
product state is expressed through characters, places and objects.

## World vocabulary

| Product concept | Primary 2D expression | Required meaning |
| --- | --- | --- |
| Agent | A distinct employee character | Identity, assignment and actual current state |
| Persistent AgentTeam | A named office or team room with its member characters | A durable team that can receive recurring work |
| TF team | A temporary project room/table with the participating characters and goal board | A goal-bound collaboration with an explicit lifecycle |
| Task | A work card on a desk, board or carried by a character | The persisted Task identity and state |
| Skill | A book, manual, note or sheet of paper | Reusable instructions the agent can consult |
| MCP/client connection | A computer application, terminal, workstation or physical tool | The actual connected tool and its detected/configured/connected/exercised state |
| Hook | A bell, trigger, inbox or linked mechanism | A configured event reaction; it must not imply that an event ran |
| Loop | A bounded repeating work board or machine with iteration markers and a stop control | Repeated Task execution with its real limit, owner and session state |

Icons are never the only carrier of meaning. Every object has an accessible
name, status text and keyboard-reachable action. Color and animation supplement,
but do not replace, persisted state.

## Teams and repeating work

An **AgentTeam** is durable. It has a home office, stable membership and a work
board. The same team can receive new Tasks and own explicitly activated bounded
Loops across sessions.

A **TF team** is goal-bound and temporary. A user forms it from existing agents,
assigns one or more Tasks, and can close it when the goal is finished. Closing a
TF does not delete agents, Task history or evidence. An agent may participate in
more than one TF only when the product can display the resulting assignments
honestly.

Repeated work is not ambient animation. A Loop belongs to a concrete saved Task
and is shown at the responsible team or TF board. Each admitted iteration uses
persisted Run evidence. Waiting, active, blocked, stopping, terminal, stale and
unavailable states remain distinct. The world offers an explicit emergency stop
only when the current process holds fresh control authority; it never invents
progress or silently restarts work.

## Core interaction loop

1. Create or select an employee character.
2. Place the employee in a persistent office or assemble a TF around a goal.
3. Put a Task card on that team's board.
4. Give the character a Skill book and, when needed, a connected MCP workstation.
5. Preview and explicitly authorize execution or a bounded Loop.
6. Watch only evidence-backed state changes, then open the Task card for attempts,
   results, ownership and recovery actions.

The spatial view and its accessible list/detail view are two presentations of
the same Task-centered model. Navigation, polling and decorative character
motion never submit provider work. Reduced-motion mode keeps all state and
controls available without ambient movement.

## Delivery slices

The next product slices should remain narrow and demonstrable:

1. Render persisted agents as keyboard-selectable characters in one office,
   with real assigned/active/blocked/idle status and a synchronized list view.
2. Render Skills as books/papers and MCP connections as workstation/tools that
   open the existing configuration and connection flows without duplicating APIs.
3. Add persistent AgentTeam offices and goal-bound TF spaces, then place saved
   Tasks and bounded Loop sessions on the correct board.

Each slice requires representative data, browser interaction, visual evidence,
empty/disconnected/error states, visible focus, sufficient contrast and a
reduced-motion check. The existing POC remains a fallback detail/configuration
surface while these world interactions are introduced; it is not evidence that
the final 2D experience is complete.
