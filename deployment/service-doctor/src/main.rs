use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const INSPECT: &str = include_str!("inspect.ps1");
const COMPONENTS: &[&str] = &["runner", "native", "desktop", "wsl", "hub", "tailscale"];
const HELP: &str = "HAPI service doctor (Windows)

Usage: service-doctor [check|info|watch] [--root PATH] [--component NAME] [--json]
                      [--interval SECONDS]

  check       Run a health snapshot (default).
  info        Add local paths, task names and endpoint authorities to the snapshot.
              Review this local inventory before sharing it.
  watch       Repeat health snapshots until Ctrl+C. JSON mode emits one line per sample.
  --root      Use the specified Windows runtime. Defaults to the installed executable's
              runtime or the current account's LocalAppData\\HAPI.
  --component Limit inspection to runner, native, desktop, wsl, hub or tailscale.
              Repeat this option to inspect several components.
  --interval  Seconds between watch snapshots, from 1 to 3600 (default 10).
  --json      Emit JSON to stdout.

Exit status: 0 healthy, 1 degraded, 2 inspection or invocation error.";

struct Options {
    mode: &'static str,
    root: PathBuf,
    components: Vec<String>,
    interval: Duration,
    json: bool,
}

fn runtime_present(path: &Path) -> bool {
    path.join("services.json").exists() || path.join("windows-native/config.json").exists()
}

fn default_root() -> Result<PathBuf, &'static str> {
    if let Ok(executable) = env::current_exe() {
        if let Some(root) = executable
            .ancestors()
            .skip(1)
            .take(4)
            .find(|p| runtime_present(p))
        {
            return Ok(root.to_path_buf());
        }
    }
    env::var_os("LOCALAPPDATA")
        .map(|path| PathBuf::from(path).join("HAPI"))
        .ok_or("LocalAppData is unavailable. Pass --root with the installed Windows runtime.")
}

fn options() -> Result<Option<Options>, &'static str> {
    let mut args = env::args_os().skip(1).peekable();
    let mode = match args.peek().and_then(|arg| arg.to_str()) {
        Some("check") => {
            args.next();
            "check"
        }
        Some("info") => {
            args.next();
            "info"
        }
        Some("watch") => {
            args.next();
            "watch"
        }
        _ => "check",
    };
    let mut root = None;
    let mut components = Vec::new();
    let mut interval = 10;
    let mut json = false;
    while let Some(flag) = args.next() {
        match flag.to_str() {
            Some("--help" | "-h") => return Ok(None),
            Some("--root") => {
                root = Some(PathBuf::from(
                    args.next().ok_or("--root requires a directory.")?,
                ))
            }
            Some("--json") => json = true,
            Some("--component") => {
                let name = args
                    .next()
                    .and_then(|arg| arg.into_string().ok())
                    .ok_or("--component requires a component name.")?;
                if !COMPONENTS.contains(&name.as_str()) {
                    return Err("Unknown component. Run service-doctor --help.");
                }
                if !components.contains(&name) {
                    components.push(name);
                }
            }
            Some("--interval") if mode == "watch" => {
                interval = args
                    .next()
                    .and_then(|arg| arg.into_string().ok())
                    .and_then(|arg| arg.parse().ok())
                    .filter(|seconds| (1..=3600).contains(seconds))
                    .ok_or("--interval must be between 1 and 3600 seconds.")?;
            }
            Some("--interval") => return Err("--interval is only available with watch."),
            _ => return Err("Unknown argument. Run service-doctor --help."),
        }
    }
    let root = match root {
        Some(path) if path.as_os_str().is_empty() => return Err("--root requires a directory."),
        Some(path) if path.is_absolute() => path,
        Some(path) => env::current_dir()
            .map_err(|_| "The current directory is unavailable.")?
            .join(path),
        None => default_root()?,
    };
    Ok(Some(Options {
        mode,
        root,
        components,
        interval: Duration::from_secs(interval),
        json,
    }))
}

fn snapshot(options: &Options) -> Result<Value, &'static str> {
    if !cfg!(windows) {
        return Err("Run service-doctor on the Windows deployment host.");
    }
    let system_root = env::var_os("SystemRoot").ok_or("Windows SystemRoot is unavailable.")?;
    let powershell =
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = Command::new(powershell);
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "[scriptblock]::Create([Console]::In.ReadToEnd()).Invoke()",
        ])
        .env("HAPI_DOCTOR_RUNTIME", &options.root)
        .env(
            "HAPI_DOCTOR_EXECUTABLE",
            env::current_exe().unwrap_or_default(),
        )
        .env("HAPI_DOCTOR_COMPONENTS", options.components.join(","))
        .env("HAPI_DOCTOR_MODE", options.mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start Windows PowerShell.")?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (sender, output) = mpsc::channel();
    thread::spawn(move || {
        let _ = stdin.write_all(INSPECT.as_bytes());
    });
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = sender.send(
            stdout
                .by_ref()
                .take(4 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map(|_| bytes),
        );
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not wait for Windows inspection.")?
        {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(100) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Inspection timed out. Check components individually with --component.");
        }
        thread::sleep(Duration::from_millis(50));
    };
    if !status.success() {
        return Err("Windows inspection failed before it produced a report.");
    }
    let bytes = output
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Windows inspection output did not close.")?
        .map_err(|_| "Could not read Windows inspection output.")?;
    serde_json::from_slice(&bytes).map_err(|_| "Windows inspection did not return a valid report.")
}

fn render(out: &mut impl Write, report: &Value, options: &Options) -> io::Result<()> {
    if options.json {
        serde_json::to_writer(&mut *out, report)?;
        return writeln!(out);
    }
    if options.mode == "watch" {
        writeln!(out, "\n{}", field(report, "checkedAtUtc"))?;
    }
    writeln!(out, "HAPI deployment: {}", field(report, "status"))?;
    if let Some(checks) = report["checks"].as_array() {
        for check in checks {
            writeln!(
                out,
                "  {:<11} {:<11} {:<22} {}",
                field(check, "status"),
                field(check, "component"),
                field(check, "check"),
                field(check, "detail")
            )?;
            if let Some(action) = check["action"].as_str() {
                writeln!(out, "               {action}")?;
            }
        }
    }
    if let Some(processes) = report["processes"]
        .as_object()
        .filter(|values| !values.is_empty())
    {
        writeln!(out, "\nVerified processes")?;
        for (role, process) in processes {
            writeln!(out, "  {role}: {}", process_label(process))?;
        }
    }
    if let Some(changes) = report["processChanges"]
        .as_array()
        .filter(|values| !values.is_empty())
    {
        writeln!(
            out,
            "\nProcess replacements since the last verified observation"
        )?;
        for change in changes {
            writeln!(
                out,
                "  {}: {} -> {}",
                field(change, "role"),
                process_label(&change["previous"]),
                process_label(&change["current"])
            )?;
        }
    }
    if let Some(inventory) = report["localInventory"].as_object() {
        writeln!(out, "\nLocal inventory (review before sharing)")?;
        for (label, value) in inventory {
            if let Some(value) = value.as_str() {
                writeln!(out, "  {label}: {value}")?;
            }
        }
    }
    Ok(())
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or_default()
}

fn process_label(process: &Value) -> String {
    format!(
        "PID {}, started {}",
        process["pid"],
        field(process, "startedAtUtc")
    )
}

fn track_process_changes(report: &mut Value, previous: &mut BTreeMap<String, Value>) {
    let changes: Vec<_> = report["processes"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(role, current)| {
            let last = previous.insert(role.clone(), current.clone())?;
            (last != *current).then(|| json!({"role": role, "previous": last, "current": current}))
        })
        .collect();
    report["processChanges"] = json!(changes);
}

fn main() -> ExitCode {
    let options = match options() {
        Ok(Some(options)) => options,
        Ok(None) => {
            println!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Err(error) => {
            eprintln!("service-doctor: {error}");
            return ExitCode::from(2);
        }
    };
    let mut out = io::stdout().lock();
    let mut previous = BTreeMap::new();
    loop {
        let mut report = snapshot(&options).unwrap_or_else(|message| {
            json!({
                "schemaVersion": 1, "status": "unavailable", "exitCode": 2,
                "checks": [{"component": "doctor", "check": "Windows inspection",
                            "status": "unavailable", "detail": message}]
            })
        });
        if options.mode == "watch" {
            track_process_changes(&mut report, &mut previous);
        }
        if let Err(error) = render(&mut out, &report, &options).and_then(|_| out.flush()) {
            return if error.kind() == io::ErrorKind::BrokenPipe {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(2)
            };
        }
        if options.mode != "watch" {
            return ExitCode::from(report["exitCode"].as_u64().unwrap_or(2) as u8);
        }
        thread::sleep(options.interval);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watch_detects_pid_reuse_after_a_missing_observation() {
        let first = json!({"pid": 42, "startedAtUtc": "2026-01-01T00:00:00.0000000Z"});
        let second = json!({"pid": 42, "startedAtUtc": "2026-01-01T00:01:00.0000000Z"});
        let mut previous = BTreeMap::new();
        let mut report = json!({"processes": {"daemon": first}});
        track_process_changes(&mut report, &mut previous);
        assert_eq!(report["processChanges"], json!([]));

        let mut unavailable = json!({"status": "unavailable"});
        track_process_changes(&mut unavailable, &mut previous);
        assert_eq!(unavailable["processChanges"], json!([]));

        let mut restarted = json!({"processes": {"daemon": second}});
        track_process_changes(&mut restarted, &mut previous);
        assert_eq!(
            restarted["processChanges"],
            json!([{
                "role": "daemon", "previous": first, "current": second
            }])
        );
    }
}
