# Verification

Executed on macOS with Node v22.23.1 at `feat/recorder-saved-values` 583e1048 (on main b8ce3c74), and on Ubuntu 24.04
VMs with snap Chromium for the agent recordings.

## Gates

- `npm run check` (typecheck, lint, format, knip, metadata, architecture guards, typed lint), `docs:check`,
  `mcp-catalog:check`, `verify:test-discovery`, `scan:todos` and `jscpd`: passed.
- `npx vitest run --project domain --project services --project adapters`: 17,855 passed and 4 failed. The 4 fail the
  same way on main in this environment: two `setupEnvironment` tests, a `GpuPayloadCodec` zstd test, and "stops
  Inspector target authorization after the current stat settles".
- Browser scenario CLI and MCP boundaries, scenario input diagnostics, the environment build CLI, tool schema validity,
  MCP schema validation, output schema constraints and profile, scenario cancellation and cleanup: 10 files, 43 passed.
- The compact MCP catalog must stay under the one-megabyte frame `outputSchemaProfile.test.ts` measures. Main
  (ff6d96bc) advertises 1,042,845 bytes. A first design with `path_params` on request and goto steps, `json_values`, and
  separate `username` and `password` unions took 1,052,236 and failed the test. This branch takes 1,046,489: saved
  values travel as `{saved:name}` placeholders, Basic credentials repeat their part union once, and repeated inner
  descriptions were dropped.

## Compatibility

- Scenarios that save nothing record the same Evidence parameters and `scenario_sha256` on main and on this branch: a
  UI-only scenario with a goto to a URL holding literal braces, and a request step with a secret query value, a cookie
  header, and literal braces in its path and JSON body.
- Main reads a capture that uses saved values: `environment-build --dry-run` of the real-Chrome capture below gives the
  same manifest, state, coverage and file plan on main and on this branch. This branch adds the
  `credential-named-saved-values` warning.
- Write plans for 102 captures (the 50 published captures, 29 earlier agent recordings and the 23 recorded in the
  comparison below), built by main and by this branch: byte-identical, 473 plans and 218 served.

## Real Chrome

A local application with a cookie-session UI and an API that takes only Basic auth, recorded with Google Chrome:

- fill a name and click Save with `save_response` on `POST /ui/items`, saving the new id;
- `goto` `/items/{saved:item1}` and wait for the item's page;
- `GET /api/items/{saved:item1}` with Basic credentials whose username comes from local storage and password from a
  declared secret;
- `POST /api/tokens`, saving the token both as a secret and, unmarked, as `session_token`;
- `POST /api/items` with the saved token in a header and `{"name": "Child of {saved:item1}", "ref": "{saved:item1}"}`;
- `PATCH /api/items/{saved:child}` and `GET /api/items?parent={saved:item1}`.

All 11 steps completed. The requests went to `/items/101`, `/api/items/101`, `/api/items/108` and `?parent=101`, and the
body sent was `{"name":"Child of 101","ref":101}`. The Evidence parameters keep the placeholders, the password appears
nowhere in the capture, and the token header is recorded as `[REDACTED:page:token.api_token]`. The token's own response
was redacted too in this run; the docs say it may not be, since the recorder reads bodies on their own schedule.
`environment-build` warned about `/parameters/actions/7/save/1`.

## Agent-built environments, main and this branch

Claude Code (`claude-sonnet-5-5`) built an environment of each application from the same prompt, with REA main
ff6d96bc (skill 49) and with this branch (skill 50), on freshly seeded instances. Each bundle was rebuilt by the REA it
was recorded with, and its write tasks run with `fireworks_ai/gpt-oss-120b` and `fireworks_ai/glm-5p3-flash`. Each task
checks its result from the environment's state, including that nothing else changed.

Two branch runs are reported. The first used this branch's skill as first written. In that run, EspoCRM's agent wrote
through request steps with Basic credentials instead of the UI, and EspoCRM's API answers in a shape the write model
withholds. The skill's recording example created its object with a request step, which agents copy. It now creates
through the UI with `save_response`. The final run uses that skill.

| Application | Write tasks | Main: served, tasks    | Branch first run: served, tasks | Branch final: served, tasks |
| ----------- | ----------- | ---------------------- | ------------------------------- | --------------------------- |
| Miniflux    | 3           | no bundle              | 3, 3/3 3/3                      | 4, 3/3 3/3                  |
| Paperless   | 3           | 3, 1/3 1/3; 6, 2/3 2/3 | 6, 2/3 2/3; 3, 1/3 1/3          | 6, 1/3 2/3                  |
| Vikunja     | 3 + 2       | 1, 0/3 0/3 + 0/2 0/2   | 4, 0/3 0/3 + 2/2 2/2            | 2, 1/3 1/3 + 0/2 0/2        |
| Linkding    | 2           | 0, 0/2 0/2             | 5, 0/2 0/2                      | 5, 0/2 0/2                  |
| Homebox     | 2           | 1, 0/2 0/2             | 3, 0/2 0/2                      | 5, 0/2 0/2                  |
| Grafana     | 2           | 2, 2/2 2/2; 3, 2/2 2/2 | 0, 0/2 0/2                      | 2, 0/2 0/2                  |
| EspoCRM     | 3           | 2, 1/3 1/3             | 0, 0/3 0/3                      | 2, 1/3 1/3                  |
| Total       | 20          | 9, 4/20 4/20           | 21, 7/20 7/20                   | 26, 6/20 7/20               |

"Served" counts the write tools the final capture serves; tasks are gpt-oss then GLM, and Miniflux's count as failed
without a bundle. Paperless and Grafana on main, and Paperless on the first branch run, were recorded twice; totals use
the first run.

- **Miniflux:** main's agent stopped and asked for an API key, since the API takes Basic auth. With Basic credentials
  the branch built an environment serving category create, rename and delete in both runs, and every category task
  passed with both models.
- **Saved ids:** in the final run every agent saved ids, with `save_response` on UI writes in Paperless, Homebox,
  Grafana and EspoCRM, and read objects back by them. On main no step can carry a value to a later one, so agents chose
  their own ids or read lists back instead.
- **EspoCRM:** the final run wrote through the UI (10 clicks) and served create and update, as main did.
- **Paperless:** run-to-run differences are as large as the difference between versions: main served 3 and 6 writes in
  two runs.
- **Linkding and Homebox** serve more writes, but their create tasks still fail. Linkding's served create requires every
  member its recorded calls sent (`description`, `notes`, `unread`, `shared`, `tag_names`), so a task that sends a URL
  and a title is refused.
- **Grafana** passed both tasks in both main runs and neither branch run. Each capture builds the same coverage with
  main and with this branch, so the difference is in what was recorded:
  - Main's agents created folders through the API with a uid they chose, and REA composes the folder's `url` from that
    uid and the title's slug.
  - The final run created them through the UI, where Grafana generates the uid. REA then learns `url` as a template
    around the generated uid that keeps the recorded folder's slug, so a served folder's address does not follow its
    title.
  - Preferring the composed rule fixes the spelling, but this capture's second folder title holds `&`, which Grafana
    slugs as `and` and REA drops, so that create would be withheld instead.
  - Both are write-model changes left for a follow-up.
- Agents spent about the same: main $7.45 and 2,235 seconds in total, the final run $8.70 and 2,880 seconds, a third of
  it Homebox's.

## Not verified

- One recording per application and version, two for Paperless and Grafana on main; agent runs vary.
- Multi-factor sign-in, and saved values in `fill` or `select_option` steps, which this change does not add.
