# Testing Schemas

> TODO: interaction tests generally use quickchr to validate code
> TODO: unit tests are "anchor test" => captures current behavior -> catch regressions in future
> TODO: code coverage is collected => **not** enforced % required -> spot trends (e.g. coverage deltas over time) to guide future quality/tests work => generally means an integration test may needed
> TODO: coverage should be collected for units test and combined units and integration (or "all" tests) => the "all" number is where trends are important, unit test coverage less so
> TODO: prefer integration test to complex mocking => RouterOS provides source of truth <-- version changes so what may work in one version, may not work in some possible future version of RouterOS => so captured response while potentially useful for quick unit test to check core logic, can never be definitive on correctness in "real life"
> TODO: @test/fixtures/*/** is for test data, use subdirectories to keep organized
