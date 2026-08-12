//! The keyboard source: reports `(token, is_down)` transitions for every key Pointy
//! can bind, regardless of which window has focus.
//!
//! Windows samples key state directly (`GetAsyncKeyState`) instead of installing a
//! WH_KEYBOARD_LL hook. Hooks looked like the obvious choice, but they are only as
//! reliable as the rest of the hook chain: whichever app installed its hook most
//! recently is called first, and any of them may swallow an event instead of passing it
//! on. That was observable on the development machine, where another always-on
//! dictation tool held a hook and Pointy's hook received nothing at all. Sampling
//! cannot be intercepted by another process.
//!
//! Cost: 12 ms polling over ~90 virtual keys, which is a few hundred microseconds of
//! CPU per second. Latency for a hold-to-talk hotkey is bounded by the same 12 ms.

/// Called for every key transition: `(token, true)` on press, `(token, false)` on
/// release. Runs on the keyboard thread, so it must not block.
pub trait KeySink: Send + 'static {
    fn on_key(&self, token: &str, down: bool);
}

#[cfg(windows)]
pub fn spawn<S: KeySink>(sink: S) -> Result<(), String> {
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    use crate::keys::WATCHED;

    const POLL: Duration = Duration::from_millis(12);

    std::thread::Builder::new()
        .name("pointy-keyboard".into())
        .spawn(move || {
            let mut held = vec![false; WATCHED.len()];
            loop {
                for (index, (codes, token)) in WATCHED.iter().enumerate() {
                    // The high bit is "currently down". The low bit ("pressed since the
                    // last call") is shared process-wide and unreliable, so it is unused.
                    let down = codes
                        .iter()
                        .any(|vk| unsafe { GetAsyncKeyState(*vk as i32) } as u16 & 0x8000 != 0);

                    if down != held[index] {
                        held[index] = down;
                        sink.on_key(token, down);
                    }
                }
                std::thread::sleep(POLL);
            }
        })
        .map_err(|e| format!("Could not start the keyboard thread: {e}"))?;

    Ok(())
}

/// macOS/Linux use rdev's event tap. SCAFFOLD on macOS: the tap needs Accessibility
/// permission, which is exactly what the permissions step asks for.
#[cfg(not(windows))]
pub fn spawn<S: KeySink>(sink: S) -> Result<(), String> {
    use rdev::{Event, EventType};

    use crate::keys::token;

    std::thread::Builder::new()
        .name("pointy-keyboard".into())
        .spawn(move || {
            let result = rdev::listen(move |event: Event| match event.event_type {
                EventType::KeyPress(key) => {
                    if let Some(token) = token(key) {
                        sink.on_key(&token, true);
                    }
                }
                EventType::KeyRelease(key) => {
                    if let Some(token) = token(key) {
                        sink.on_key(&token, false);
                    }
                }
                _ => {}
            });
            if let Err(err) = result {
                eprintln!("keyboard tap stopped: {err:?}");
            }
        })
        .map_err(|e| format!("Could not start the keyboard thread: {e}"))?;

    Ok(())
}
