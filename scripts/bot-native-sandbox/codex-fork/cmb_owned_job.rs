//! CMBDevClaw private elevated runner admission. Optional and absent for normal
//! Codex/Cmb calls; a model permission profile cannot select a Job name.
use anyhow::{Context, Result};
use std::os::windows::io::OwnedHandle;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, OpenJobObjectW};
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::SystemServices::{JOB_OBJECT_ASSIGN_PROCESS,JOB_OBJECT_QUERY};

pub(crate) struct CmbOwnedJob(OwnedHandle);
/// Read only from the trusted CLI process environment. A SpawnRequest or model
/// permission profile cannot enable the Bot computer's native desktop mode.
pub(crate) fn native_desktop_requested() -> Result<bool> {
    let Some(value) = std::env::var_os("CMB_BOT_NATIVE_DESKTOP") else { return Ok(false); };
    if value != "1" { anyhow::bail!("invalid Bot native desktop mode"); }
    let name = std::env::var_os("CMB_BOT_RESOURCE_JOB").context("native desktop requires owned Bot Job")?;
    validate_job_name(name.to_str().context("Bot Job name is not Unicode")?)?;
    Ok(true)
}
fn validate_job_name(text: &str) -> Result<()> {
    let suffix = text.strip_prefix("Local\\CMBDevClaw-Bot-").context("invalid Bot Job prefix")?;
    if suffix.len() != 36 || suffix.chars().enumerate().any(|(index,character)| {
        if [8,13,18,23].contains(&index) { character != '-' } else { !character.is_ascii_hexdigit() }
    }) { anyhow::bail!("invalid Bot Job nonce"); }
    Ok(())
}
impl CmbOwnedJob {
    pub(crate) fn assign_and_resume(&self, process: HANDLE, thread: HANDLE) -> Result<()> {
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle() as HANDLE, process) } == 0 {
            return Err(std::io::Error::last_os_error()).context("assign strict Bot runner Job");
        }
        if unsafe { ResumeThread(thread) } == u32::MAX {
            return Err(std::io::Error::last_os_error()).context("resume strict Bot runner Job");
        }
        Ok(())
    }
}
pub(crate) fn open_from_environment() -> Result<Option<CmbOwnedJob>> {
    let Some(name) = std::env::var_os("CMB_BOT_RESOURCE_JOB") else { return Ok(None); };
    let text = name.to_str().context("Bot Job name is not Unicode")?;
    validate_job_name(text)?;
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // Current desktop user owns this DACL. The restricted command account has
    // no Job handle/name grant; the handle is not inherited into the command.
    let raw = unsafe { OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS | JOB_OBJECT_QUERY, 0, wide.as_ptr()) };
    if raw == 0 { return Err(std::io::Error::last_os_error()).context("open actual Bot Job"); }
    Ok(Some(CmbOwnedJob(unsafe { OwnedHandle::from_raw_handle(raw as *mut std::ffi::c_void) })))
}
