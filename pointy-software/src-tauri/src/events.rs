//! OS accessibility event subscriptions — the idle-time heart of Pointy.
//!
//! Nothing here polls a screenshot or diffs pixels. Instead we register three
//! UI Automation event handlers and let Windows tell us when something changed:
//!
//! * `UIA_AutomationFocusChangedEventId`  — keyboard focus moved
//! * `UIA_StructureChangedEventId`        — the tree of the target window changed
//! * `UIA_Window_WindowOpenedEventId`     — a new top-level window appeared
//!
//! Events arrive on a dedicated STA thread that pumps messages (COM event
//! handlers are only delivered to a thread with a running message loop). They
//! are funneled through a small channel to a debouncer that collapses a burst
//! into one trigger (a burst of internal redraws must not fire the pipeline
//! many times), logs `EVENT: ...`, and then invokes the callback. Only from
//! there does any capture / AI work begin.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// Collapse a burst of events into one trigger. 250ms is inside the required
/// 150-300ms window.
pub const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    FocusChanged,
    StructureChanged,
    WindowOpened,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::FocusChanged => "focus-changed",
            EventKind::StructureChanged => "structure-changed",
            EventKind::WindowOpened => "window-opened",
        }
    }
}

/// Handle to a running listener. Dropping it stops the message loop and the
/// debouncer.
pub struct EventListener {
    stop: Arc<AtomicBool>,
    _threads: Vec<std::thread::JoinHandle<()>>,
}

impl EventListener {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Subscribe to accessibility events and call `on_event` once per debounced
/// burst. `window_id` narrows structure-changed events to that window's
/// subtree; `None` watches the whole desktop tree (noisier, still debounced).
pub fn listen(
    window_id: Option<u32>,
    on_event: Arc<dyn Fn(EventKind) + Send + Sync>,
) -> Result<EventListener, String> {
    #[cfg(windows)]
    {
        imp::start(window_id, on_event)
    }
    #[cfg(not(windows))]
    {
        let _ = (window_id, on_event);
        Err("Accessibility event listening is not implemented on this platform.".to_string())
    }
}

/// Wall-clock timestamp as milliseconds since the Unix epoch, plus a compact
/// UTC `HH:MM:SS.mmm` rendering for the "at <time>" part of the log line.
pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Emit the single-line end-to-end latency report. All timestamps are epoch
/// milliseconds. `total` is event → TTS start, the time the user actually waits
/// before hearing the first instruction.
pub fn log_latency(t0: u128, t1: u128, t2: u128, t3: u128, t4: u128, t5: u128, t6: u128) {
    eprintln!(
        "LATENCY: T0={t0} T1={t1} T2={t2} T3={t3} T4={t4} T5={t5} T6={t6} \
         | event_to_screenshot={}ms screenshot_to_request={}ms \
         | request_to_first_token={}ms generation_time={}ms | total={}ms",
        t1.saturating_sub(t0),
        t2.saturating_sub(t1),
        t3.saturating_sub(t2),
        t4.saturating_sub(t3),
        t6.saturating_sub(t0),
    );
}

pub fn fmt_time(ms: u128) -> String {
    let secs = (ms / 1000) as u64;
    let millis = (ms % 1000) as u32;
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}.{millis:03}")
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::mpsc::{Receiver, Sender};

    use windows::core::{implement, Ref};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, SAFEARRAY,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationEventHandler,
        IUIAutomationEventHandler_Impl, IUIAutomationFocusChangedEventHandler,
        IUIAutomationFocusChangedEventHandler_Impl, IUIAutomationStructureChangedEventHandler,
        IUIAutomationStructureChangedEventHandler_Impl, StructureChangeType, TreeScope_Children,
        TreeScope_Subtree, UIA_EVENT_ID, UIA_Window_WindowOpenedEventId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };

    // COM event sinks. Each handler just pushes its kind onto the shared channel;
    // all interpretation, debounce and logging happen on the debouncer thread.
    #[implement(IUIAutomationEventHandler)]
    struct AutomationSink {
        tx: Sender<EventKind>,
    }

    impl IUIAutomationEventHandler_Impl for AutomationSink_Impl {
        fn HandleAutomationEvent(
            &self,
            sender: Ref<IUIAutomationElement>,
            eventid: UIA_EVENT_ID,
        ) -> windows::core::Result<()> {
            let kind = if eventid == UIA_Window_WindowOpenedEventId {
                EventKind::WindowOpened
            } else {
                EventKind::StructureChanged
            };
            // Pointy's own overlay shows/hides during capture; never let it
            // count as a real change.
            if let Some(element) = sender.as_ref() {
                if let Ok(pid) = unsafe { element.CurrentProcessId() } {
                    if pid as u32 == std::process::id() {
                        return Ok(());
                    }
                }
            }
            let _ = self.tx.send(kind);
            Ok(())
        }
    }

    #[implement(IUIAutomationFocusChangedEventHandler)]
    struct FocusSink {
        tx: Sender<EventKind>,
    }

    impl IUIAutomationFocusChangedEventHandler_Impl for FocusSink_Impl {
        fn HandleFocusChangedEvent(
            &self,
            sender: Ref<IUIAutomationElement>,
        ) -> windows::core::Result<()> {
            // Focus bouncing onto Pointy's own window is self-noise, not the
            // user doing something in the target app.
            if let Some(element) = sender.as_ref() {
                if let Ok(pid) = unsafe { element.CurrentProcessId() } {
                    if pid as u32 == std::process::id() {
                        return Ok(());
                    }
                }
            }
            let _ = self.tx.send(EventKind::FocusChanged);
            Ok(())
        }
    }

    #[implement(IUIAutomationStructureChangedEventHandler)]
    struct StructureSink {
        tx: Sender<EventKind>,
    }

    impl IUIAutomationStructureChangedEventHandler_Impl for StructureSink_Impl {
        fn HandleStructureChangedEvent(
            &self,
            sender: Ref<IUIAutomationElement>,
            _changetype: StructureChangeType,
            _runtimeid: *const SAFEARRAY,
        ) -> windows::core::Result<()> {
            // Showing/hiding Pointy's own webview can produce structure events.
            // They are never user progress and must not advance a walkthrough.
            if let Some(element) = sender.as_ref() {
                if let Ok(pid) = unsafe { element.CurrentProcessId() } {
                    if pid as u32 == std::process::id() {
                        return Ok(());
                    }
                }
            }
            let _ = self.tx.send(EventKind::StructureChanged);
            Ok(())
        }
    }

    pub fn start(
        window_id: Option<u32>,
        on_event: Arc<dyn Fn(EventKind) + Send + Sync>,
    ) -> Result<EventListener, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx): (Sender<EventKind>, Receiver<EventKind>) = mpsc::channel();

        // Debouncer: collapse a burst into one trigger, log it, fire the callback.
        let debounce_stop = stop.clone();
        let debouncer = std::thread::Builder::new()
            .name("pointy-events-debounce".into())
            .spawn(move || debounce_loop(rx, on_event, debounce_stop))
            .map_err(|e| format!("Could not start event debouncer: {e}"))?;

        // STA thread: register handlers and pump messages until stopped.
        let loop_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("pointy-events".into())
            .spawn(move || message_loop(window_id, tx, loop_stop))
            .map_err(|e| format!("Could not start event listener: {e}"))?;

        Ok(EventListener {
            stop,
            _threads: vec![debouncer, thread],
        })
    }

    fn message_loop(window_id: Option<u32>, tx: Sender<EventKind>, stop: Arc<AtomicBool>) {
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if init.is_err() {
                eprintln!("[events] COM init failed, no events will fire: {init:?}");
                return;
            }

            let registered = register(window_id, tx);

            // Pump messages so the COM callbacks are delivered. This is the only
            // thing the loop does while idle — no screenshots, no model calls.
            let mut msg = MSG::default();
            while !stop.load(Ordering::SeqCst) {
                let got = PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE);
                if got.as_bool() {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                } else {
                    std::thread::sleep(Duration::from_millis(25));
                }
            }

            // Dropping `registered` releases the handlers; UIA unregisters them
            // when the last reference goes away.
            drop(registered);

            if init.is_ok() {
                CoUninitialize();
            }
        }
    }

    /// Register all three handlers. Returns the automation object and the
    /// handler interface refs, kept alive for the lifetime of the loop.
    fn register(window_id: Option<u32>, tx: Sender<EventKind>) -> Option<Registration> {
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;

            let root = automation.GetRootElement().ok()?;

            // Scope structure events to the target window when one is known,
            // otherwise the whole desktop.
            let structure_scope: IUIAutomationElement = match window_id {
                Some(id) => automation
                    .ElementFromHandle(HWND(id as isize as *mut _))
                    .ok()
                    .unwrap_or_else(|| root.clone()),
                None => root.clone(),
            };

            let automation_sink: IUIAutomationEventHandler =
                AutomationSink { tx: tx.clone() }.into();
            let focus_sink: IUIAutomationFocusChangedEventHandler =
                FocusSink { tx: tx.clone() }.into();
            let structure_sink: IUIAutomationStructureChangedEventHandler =
                StructureSink { tx: tx.clone() }.into();

            // Window-opened: top-level windows are direct children of the desktop.
            if let Err(err) = automation.AddAutomationEventHandler(
                UIA_Window_WindowOpenedEventId,
                &root,
                TreeScope_Children,
                None,
                &automation_sink,
            ) {
                eprintln!("[events] window-opened registration failed: {err}");
            }
            // Focus changes are global (no element scope).
            if let Err(err) = automation.AddFocusChangedEventHandler(None, &focus_sink) {
                eprintln!("[events] focus-changed registration failed: {err}");
            }
            // Structure changes within the target window's subtree.
            if let Err(err) = automation.AddStructureChangedEventHandler(
                &structure_scope,
                TreeScope_Subtree,
                None,
                &structure_sink,
            ) {
                eprintln!("[events] structure-changed registration failed: {err}");
            }

            Some(Registration {
                _automation: automation,
                _root: root,
                _structure_scope: structure_scope,
                _automation_sink: automation_sink,
                _focus_sink: focus_sink,
                _structure_sink: structure_sink,
            })
        }
    }

    /// Keep the COM objects alive; dropping this unregisters the handlers.
    struct Registration {
        _automation: IUIAutomation,
        _root: IUIAutomationElement,
        _structure_scope: IUIAutomationElement,
        _automation_sink: IUIAutomationEventHandler,
        _focus_sink: IUIAutomationFocusChangedEventHandler,
        _structure_sink: IUIAutomationStructureChangedEventHandler,
    }

    fn debounce_loop(
        rx: Receiver<EventKind>,
        on_event: Arc<dyn Fn(EventKind) + Send + Sync>,
        stop: Arc<AtomicBool>,
    ) {
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            // Wait for the first event of a burst.
            let first = match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(kind) => kind,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };

            // Keep draining for DEBOUNCE so one burst → one trigger.
            let deadline = Instant::now() + DEBOUNCE;
            let mut kinds = vec![first];
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(kind) => kinds.push(kind),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            // Log each distinct event type once, then fire a single trigger.
            let mut seen = kinds.clone();
            seen.dedup();
            for kind in &seen {
                let ms = super::now_millis();
                eprintln!(
                    "EVENT: {} at {} (epoch {} ms)",
                    kind.as_str(),
                    super::fmt_time(ms),
                    ms
                );
            }

            // The trigger reports the *most recent* kind so the pipeline can
            // react to what actually just happened.
            if let Some(kind) = kinds.last().copied() {
                on_event(kind);
            }
        }
    }

    use windows::Win32::Foundation::HWND;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real end-to-end verification of Part 1: register the accessibility
    /// event subscriptions, then cause a genuine UI change (open Notepad) and
    /// confirm the debounced trigger fires. Run with:
    ///   cargo test real_event_fires -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_event_fires() {
        let (tx, rx) = std::sync::mpsc::channel::<EventKind>();
        let listener = listen(None, Arc::new(move |kind| {
            let _ = tx.send(kind);
        }))
        .expect("register a11y listeners");

        // Give registration and the message loop a moment to settle.
        std::thread::sleep(Duration::from_millis(600));

        // A real UI change: Notepad appears (window-opened + focus-changed).
        let mut child = std::process::Command::new("notepad.exe")
            .spawn()
            .expect("spawn notepad");

        let result = rx.recv_timeout(Duration::from_secs(8));
        let _ = child.kill();
        listener.stop();

        match result {
            Ok(kind) => println!("TRIGGERED: {:?}", kind),
            Err(e) => panic!("no a11y event fired within 8s: {e}"),
        }
    }
}
