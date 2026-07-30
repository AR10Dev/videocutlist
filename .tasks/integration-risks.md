# Integration Risks

- B and I begin beside A but require A's workspace commit before final tests.
- C emits process bytes; D owns fan-out and cache publication. Their shared
  adapter is controller-owned and must be committed before the core wave.
- F and G consume OpenAPI v1 and may not redefine it independently.
- Migrations are numbered by the controller: media 001, projects 002, jobs 003,
  cache 004.
- Hardware behavior cannot be accepted in the controller environment.

