# toggl-export
Exports toogl.com log entries to scalableminds time-tracker. Update operations are not idempotent, so please be careful.

## Installation
`yarn global add https://github.com/jfrohnhofen/toggl-export.git`

## Usage
```
$ toggl-export --help

TogglExport

  Exports toggl.com time entries to scalableminds time tracker.

Options

  --from yyyy-mm-dd    Export entries logged on or after that date (until - 1 week).
  --until yyyy-mm-dd   Export entries logged before or on that date (today).
  --config             Update configuration.
  --help               Print this message.
  ```
