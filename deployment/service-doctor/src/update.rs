use serde_json::Value;
use std::{env, fs, path::Path, process::Command};

#[derive(Clone, Copy)]
pub enum Target {
    WslCodex,
    Tailscale,
}

fn execute(mut command: Command) -> Result<(), String> {
    let status = command.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Updater exited with {status}."))
    }
}

pub fn run(target: Target, root: &Path) -> Result<(), String> {
    if matches!(target, Target::Tailscale) {
        let program_files = env::var_os("ProgramFiles").ok_or("ProgramFiles is unavailable.")?;
        let mut cmd = Command::new(Path::new(&program_files).join("Tailscale/tailscale.exe"));
        cmd.arg("update");
        return execute(cmd);
    }
    let data = fs::read_to_string(root.join("services.json"))
        .map_err(|e| format!("Cannot read services.json: {e}"))?;
    let config: Value = serde_json::from_str(data.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Invalid services.json: {e}"))?;
    let setting = |key: &str| {
        config["wsl"][key]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && !s.starts_with('-')
                    && s.trim() == *s
                    && !s.chars().any(char::is_control)
            })
            .ok_or_else(|| format!("Invalid wsl.{key} in services.json."))
    };
    let distro = setting("distribution")?;
    let user = setting("linuxUser")?;
    let windows = env::var_os("SystemRoot").ok_or("SystemRoot is unavailable.")?;
    let wsl = |script: &str| {
        let mut cmd = Command::new(Path::new(&windows).join("System32/wsl.exe"));
        cmd.args([
            "--distribution",
            distro,
            "--user",
            user,
            "--cd",
            "~",
            "--exec",
            "/bin/bash",
            "-lc",
            script,
        ]);
        cmd
    };
    let versions = || -> Result<(String, bool), String> {
        let output = wsl("exec codex app-server daemon version")
            .stderr(std::process::Stdio::inherit())
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Could not query the Codex daemon version.".into());
        }
        let data: Value = serde_json::from_slice(&output.stdout)
            .map_err(|e| format!("Invalid daemon version response: {e}"))?;
        let cli = data["cliVersion"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("Missing Codex CLI version.")?;
        Ok((
            cli.to_owned(),
            data["status"] == "running"
                && data["managedCodexVersion"] == cli
                && data["appServerVersion"] == cli,
        ))
    };
    execute(wsl("exec codex update"))?;
    let (mut version, matches) = versions()?;
    if !matches {
        execute(wsl("exec codex app-server daemon update --from-cli --yes"))?;
        let (running, matches) = versions()?;
        if !matches {
            return Err("The running Codex daemon does not match the updated CLI.".into());
        }
        version = running;
    }
    println!("WSL Codex CLI and daemon: {version}");
    Ok(())
}
