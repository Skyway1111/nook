//! On Linux, nook leaves priorities alone. Raising a process above normal takes CAP_SYS_NICE there, which
//! an app the user runs doesn't have, and the scheduler already favors processes that wait on input.
pub fn keep_typing_path_elevated(_shell: &str) {}
