use std::path::PathBuf;

use dialoguer::{Confirm, Input};

use super::validation::{
    has_prior_install, is_inside_cloud_sync, is_removable_or_network_root, is_writable,
};

/// Collapse a `dialoguer::Error` into an `io::Error` so the interactive
/// helpers can use `?` alongside `std::fs` calls in the same `io::Result`.
fn io_err(e: dialoguer::Error) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

/// Run the interactive first-run setup and return the chosen `data_dir`.
///
/// This is only reached when no `config.toml` exists and no unattended
/// `--data-dir`/`NODUS_DATA_DIR` source was supplied. It prompts with a
/// sensible default, then runs the (blocking or non-blocking) safety checks
/// before returning a path we are willing to adopt.
pub fn interactive_data_dir(default: PathBuf) -> std::io::Result<PathBuf> {
    let chosen: String = Input::new()
        .with_prompt("Directory for node data (objects + database)")
        .default(default.display().to_string())
        .interact_text()
        .map_err(io_err)?;

    let path = PathBuf::from(chosen.trim());

    if !path.exists() {
        // Creating a brand-new directory is the safe case; warn about the
        // cloud/removable concerns only once the directory is known to exist,
        // since mount checks on a not-yet-created path are meaningless.
        if Confirm::new()
            .with_prompt(format!("{} does not exist. Create it?", path.display()))
            .default(true)
            .interact()
            .map_err(io_err)?
        {
            super::validation::ensure_dir(&path)?;
        } else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Declined to create the data directory",
            ));
        }
    }

    // The directory must accept writes, or the node cannot create its DB and
    // object store later.
    if !is_writable(&path) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is not writable", path.display()),
        ));
    }

    // Blocking: never silently adopt a directory from a prior install.
    if has_prior_install(&path)
        && !Confirm::new()
            .with_prompt(format!(
                "{} already contains node data from a previous install. \
                 Adopt it as-is?",
                path.display()
            ))
            .default(false)
            .interact()
            .map_err(io_err)?
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Refused to adopt a directory containing existing node data",
        ));
    }

    // Non-blocking warnings.
    if is_inside_cloud_sync(&path) {
        let _ = Confirm::new()
            .with_prompt(
                "This path looks like it is inside a cloud-sync folder \
                 (Dropbox/OneDrive/Google Drive/iCloud). Node data may be \
                 mirrored to the cloud. Continue?",
            )
            .default(true)
            .interact()
            .map_err(io_err)?;
    }
    if is_removable_or_network_root(&path) {
        let _ = Confirm::new()
            .with_prompt(
                "This path looks like a removable or network drive. If the \
                 drive is unmounted the node cannot start. Continue?",
            )
            .default(true)
            .interact()
            .map_err(io_err)?;
    }

    Ok(path)
}
