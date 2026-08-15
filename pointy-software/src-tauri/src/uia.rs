//! Windows-only: replace the model's guessed box with the real UI Automation
//! bounding rectangle of the element it named. Strictly best-effort — every
//! failure returns None and the caller keeps the model's coordinates, so a
//! broken or missing tree can never make pointing worse.

#[cfg(windows)]
use std::collections::HashSet;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, RECT};
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
#[cfg(windows)]
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCondition, IUIAutomationElement,
    IUIAutomationTogglePattern, TreeScope_Descendants, ToggleState_On,
    UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId,
    UIA_EditControlTypeId, UIA_HyperlinkControlTypeId, UIA_ListItemControlTypeId,
    UIA_MenuItemControlTypeId, UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId,
    UIA_TogglePatternId, UIA_TreeItemControlTypeId,
};

use serde::Serialize;

#[cfg(windows)]
use crate::capture::AskCapture;
#[cfg(windows)]
use crate::nim::ClickTarget;

/// How many descendants we are willing to walk while matching. Browsers expose
/// huge trees; past this we give up and keep the model's box.
#[cfg(windows)]
const MAX_ELEMENTS: i32 = 3000;

#[cfg(windows)]
/// The handle of whichever window currently has focus, for "this whole screen"
/// walks that have no explicit pick.
pub fn foreground_window() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        None
    } else {
        Some(hwnd.0 as u32)
    }
}

/// A cheap snapshot of a window's accessibility state. Taken only when an
/// event has already fired — never on a timer — so the guide can decide
/// locally (no AI call, no screenshot) whether the step actually finished.
#[cfg(windows)]
#[derive(Debug, Clone, Default)]
pub struct UiSnapshot {
    pub title: String,
    pub toggled: Vec<String>,
    pub count: i32,
}

#[cfg(not(windows))]
#[derive(Debug, Clone, Default)]
pub struct UiSnapshot {
    pub title: String,
    pub toggled: Vec<String>,
    pub count: i32,
}

#[cfg(not(windows))]
pub fn snapshot(_window_id: Option<u32>) -> Option<UiSnapshot> {
    None
}

#[cfg(windows)]
pub fn snapshot(window_id: Option<u32>) -> Option<UiSnapshot> {
    let id = window_id?;
    std::thread::Builder::new()
        .name("pointy-uia-snapshot".into())
        .spawn(move || snapshot_thread(id))
        .ok()?
        .join()
        .ok()?
}

#[cfg(windows)]
fn snapshot_thread(window_id: u32) -> Option<UiSnapshot> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation
            .ElementFromHandle(HWND(window_id as *mut std::ffi::c_void))
            .ok()?;
        let title = root
            .CurrentName()
            .ok()
            .map(|n| n.to_string())
            .unwrap_or_default();

        let condition: IUIAutomationCondition = automation.CreateTrueCondition().ok()?;
        let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let count = elements.Length().ok()?;

        let mut toggled: Vec<String> = Vec::new();
        for i in 0..count.min(MAX_ELEMENTS) {
            let element = elements.GetElement(i).ok()?;
            let state = element
                .GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                .ok()
                .and_then(|pattern| pattern.CurrentToggleState().ok());
            if state == Some(ToggleState_On) {
                if let Ok(name) = element.CurrentName() {
                    let name = name.to_string();
                    if !name.trim().is_empty() {
                        toggled.push(name.trim().to_string());
                    }
                }
            }
        }

        if init.is_ok() {
            CoUninitialize();
        }
        Some(UiSnapshot {
            title,
            toggled,
            count,
        })
    }
}

/// Where the real UI Automation rectangle of a named element puts the dot.
/// Everything is in physical pixels except the `f*` fields, which are 0..1
/// fractions of the full virtual desktop (so the overlay can place the dot on
/// any monitor).
#[derive(Debug, Clone, Serialize)]
pub struct DotPoint {
    pub label: String,
    /// Raw bounding rectangle, physical pixels, virtual-screen coordinates.
    pub raw_x: i32,
    pub raw_y: i32,
    pub raw_w: i32,
    pub raw_h: i32,
    /// DPI scale of the monitor the element sits on (1.0 / 1.25 / 1.5 …).
    pub dpi_scale: f64,
    /// Center of the rectangle, physical pixels.
    pub dot_x: i32,
    pub dot_y: i32,
    /// Bounding box as 0..1 fractions of the virtual desktop.
    pub fx: f64,
    pub fy: f64,
    pub fw: f64,
    pub fh: f64,
    /// Center of the box as 0..1 fractions of the virtual desktop (the exact
    /// point the overlay dot is drawn at).
    pub cx: f64,
    pub cy: f64,
}

/// Resolve `target` against the real accessibility tree: return the refined
/// box (shot-relative fractions; the model's box when the element can't be
/// mapped) and the exact dot, whose POSITION line is logged here so the
/// physical point can be compared against a manual click.
#[cfg(windows)]
pub fn resolve(
    window_id: u32,
    shot: &AskCapture,
    target: &ClickTarget,
) -> (Option<ClickTarget>, Option<DotPoint>) {
    let Some(point) = point_for_label(window_id, &target.label) else {
        return (Some(target.clone()), None);
    };

    // Virtual-desktop fractions -> fractions of the captured crop, the same
    // space the model's box and the frontend mapping already use.
    let sx = (point.fx - shot.x) / shot.w;
    let sy = (point.fy - shot.y) / shot.h;
    let sw = point.fw / shot.w;
    let sh = point.fh / shot.h;
    let refined = if sx < -0.05 || sy < -0.05 || sx > 1.05 || sy > 1.05 {
        None
    } else {
        Some(ClickTarget {
            label: target.label.clone(),
            x: sx.clamp(0.0, 1.0),
            y: sy.clamp(0.0, 1.0),
            w: sw.clamp(0.0, 1.0),
            h: sh.clamp(0.0, 1.0),
        })
    };

    (refined.or(Some(target.clone())), Some(point))
}

#[cfg(not(windows))]
pub fn resolve(
    _window_id: u32,
    _shot: &AskCapture,
    target: &ClickTarget,
) -> (Option<ClickTarget>, Option<DotPoint>) {
    (Some(target.clone()), None)
}

/// Resolve the exact physical point of a named element from the accessibility
/// tree, log the POSITION line, and return the center dot plus virtual-desktop
/// fractions.
#[cfg(windows)]
pub fn point_for_label(window_id: u32, label: &str) -> Option<DotPoint> {
    let rect = find_rect(window_id, label)?;
    dot_from_rect(rect, label)
}

/// The dot of the first named element with a non-empty bounding rectangle.
/// Used by the positioning smoke test and as a no-label fallback.
#[cfg(all(test, windows))]
pub fn first_point(window_id: u32) -> Option<DotPoint> {
    let (rect, name) = first_named_rect(window_id)?;
    dot_from_rect(rect, &name)
}

/// Turn a raw UIA rectangle into the logged dot + virtual-desktop fractions.
#[cfg(windows)]
fn dot_from_rect(rect: RECT, label: &str) -> Option<DotPoint> {
    let left = rect.left;
    let top = rect.top;
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w <= 0 || h <= 0 {
        return None;
    }

    // Center of the control: the point the dot marks.
    let dot_x = left + w / 2;
    let dot_y = top + h / 2;

    let (vx, vy, vw, vh) = crate::capture::virtual_desktop_bounds();
    let vw = vw.max(1) as f64;
    let vh = vh.max(1) as f64;
    let dpi_scale = monitor_scale_at(dot_x, dot_y).unwrap_or(1.0);

    eprintln!(
        "POSITION: raw_rect=({},{},{},{}) dpi_scale={:.2} computed_dot=({},{}) overlay_window_origin=({},{})",
        left, top, w, h, dpi_scale, dot_x, dot_y, vx, vy
    );

    Some(DotPoint {
        label: label.to_string(),
        raw_x: left,
        raw_y: top,
        raw_w: w,
        raw_h: h,
        dpi_scale,
        dot_x,
        dot_y,
        fx: (left as f64 - vx as f64) / vw,
        fy: (top as f64 - vy as f64) / vh,
        fw: w as f64 / vw,
        fh: h as f64 / vh,
        cx: (left as f64 + w as f64 / 2.0 - vx as f64) / vw,
        cy: (top as f64 + h as f64 / 2.0 - vy as f64) / vh,
    })
}

/// Walk a window's tree and return the first named element with a real rect.
#[cfg(all(test, windows))]
fn first_named_rect(window_id: u32) -> Option<(RECT, String)> {
    std::thread::Builder::new()
        .name("pointy-uia-first".into())
        .spawn(move || first_named_thread(window_id))
        .ok()?
        .join()
        .ok()?
}

#[cfg(all(test, windows))]
fn first_named_thread(window_id: u32) -> Option<(RECT, String)> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation
            .ElementFromHandle(HWND(window_id as *mut std::ffi::c_void))
            .ok()?;
        let condition: IUIAutomationCondition = automation.CreateTrueCondition().ok()?;
        let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let len = elements.Length().ok()?;

        for i in 0..len.min(MAX_ELEMENTS) {
            let element = elements.GetElement(i).ok()?;
            let Ok(name) = element.CurrentName() else { continue };
            let name = name.to_string();
            if name.trim().is_empty() {
                continue;
            }
            let rect = element.CurrentBoundingRectangle().ok()?;
            if rect.right - rect.left > 0 && rect.bottom - rect.top > 0 {
                if init.is_ok() {
                    CoUninitialize();
                }
                return Some((rect, name));
            }
        }

        if init.is_ok() {
            CoUninitialize();
        }
        None
    }
}

#[cfg(target_os = "macos")]
pub fn point_for_label(_window_id: u32, label: &str) -> Option<DotPoint> {
    // macOS: the AXUIElement frame comes top-left-origin in CoreGraphics
    // points; the screen's Y must be flipped before use:
    //   flippedY = screenHeight - axY - elementHeight
    // AXObserver / AXUIElement plumbing is not wired on this build (Windows is
    // the current target), so no point is produced.
    let _ = label;
    None
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn point_for_label(_window_id: u32, label: &str) -> Option<DotPoint> {
    let _ = label;
    None
}

/// DPI scale of the monitor whose area contains the physical point.
#[cfg(windows)]
fn monitor_scale_at(x: i32, y: i32) -> Option<f64> {
    for monitor in xcap::Monitor::all().ok()? {
        let mx = monitor.x().ok()?;
        let my = monitor.y().ok()?;
        let mw = monitor.width().ok()? as i32;
        let mh = monitor.height().ok()? as i32;
        if x >= mx && x < mx + mw && y >= my && y < my + mh {
            return Some(monitor.scale_factor().ok()? as f64);
        }
    }
    None
}

#[cfg(windows)]
fn find_rect(window_id: u32, label: &str) -> Option<RECT> {
    let label = label.to_string();
    std::thread::Builder::new()
        .name("pointy-uia-refine".into())
        .spawn(move || uia_thread(window_id, &label))
        .ok()?
        .join()
        .ok()?
}

#[cfg(windows)]
fn uia_thread(window_id: u32, label: &str) -> Option<RECT> {
    unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let root = automation
            .ElementFromHandle(HWND(window_id as *mut std::ffi::c_void))
            .ok()?;
        let condition: IUIAutomationCondition = automation.CreateTrueCondition().ok()?;
        let elements = root.FindAll(TreeScope_Descendants, &condition).ok()?;
        let len = elements.Length().ok()?;

        let mut best: Option<(f64, RECT)> = None;
        for i in 0..len.min(MAX_ELEMENTS) {
            let element = elements.GetElement(i).ok()?;
            let name = element.CurrentName().ok()?;
            let Some(score) = match_score(label, &name.to_string()) else {
                continue;
            };
            let rect = element.CurrentBoundingRectangle().ok()?;
            if rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0 {
                continue;
            }
            let score = score * control_bonus(&element);
            if best.as_ref().map_or(true, |(best_score, _)| score > *best_score) {
                best = Some((score, rect));
            }
        }

        if init.is_ok() {
            CoUninitialize();
        }
        best.filter(|(score, _)| *score >= 0.55).map(|(_, rect)| rect)
    }
}

#[cfg(windows)]
fn control_bonus(element: &IUIAutomationElement) -> f64 {
    let Ok(control_type) = (unsafe { element.CurrentControlType() }) else {
        return 1.0;
    };
    const INTERACTIVE: [i32; 10] = [
        UIA_ButtonControlTypeId.0,
        UIA_CheckBoxControlTypeId.0,
        UIA_ComboBoxControlTypeId.0,
        UIA_EditControlTypeId.0,
        UIA_HyperlinkControlTypeId.0,
        UIA_ListItemControlTypeId.0,
        UIA_MenuItemControlTypeId.0,
        UIA_RadioButtonControlTypeId.0,
        UIA_TabItemControlTypeId.0,
        UIA_TreeItemControlTypeId.0,
    ];
    if INTERACTIVE.contains(&control_type.0) {
        1.05
    } else {
        0.95
    }
}

/// Score how well `name` (a real UI element) matches `label` (the model's guess).
/// None means "no meaningful match".
#[cfg(windows)]
fn match_score(label: &str, name: &str) -> Option<f64> {
    let l = label.trim().to_lowercase();
    let n = name.trim().to_lowercase();
    if l.is_empty() || n.is_empty() {
        return None;
    }
    if n == l {
        return Some(1.0);
    }
    if n.contains(l.as_str()) || l.contains(n.as_str()) {
        let ratio = l.len().min(n.len()) as f64 / l.len().max(n.len()).max(1) as f64;
        return Some(0.8 + 0.2 * ratio);
    }
    let l_tokens: HashSet<&str> = l
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let n_tokens: HashSet<&str> = n
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    let overlap = l_tokens.intersection(&n_tokens).count();
    if overlap == 0 {
        return None;
    }
    let total = l_tokens.len().max(n_tokens.len()).max(1);
    Some(0.4 + 0.5 * (overlap as f64 / total as f64))
}

#[cfg(all(test, windows))]
mod tests {
    /// Open a real app, find a real element in its accessibility tree, and log
    /// the POSITION line. Run with:
    ///   cargo test dot_position_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn dot_position_smoke() {
        let mut child = std::process::Command::new("notepad.exe")
            .spawn()
            .expect("spawn notepad");
        std::thread::sleep(std::time::Duration::from_millis(1200));

        let hwnd = crate::uia::foreground_window().expect("foreground window (notepad)");
        match crate::uia::first_point(hwnd) {
            Some(point) => println!(
                "DOT: label={:?} raw_rect=({},{},{},{}) dpi_scale={} dot=({},{}) fx={:.4} fy={:.4}",
                point.label,
                point.raw_x,
                point.raw_y,
                point.raw_w,
                point.raw_h,
                point.dpi_scale,
                point.dot_x,
                point.dot_y,
                point.fx,
                point.fy
            ),
            None => println!("DOT: no named element found in notepad's tree"),
        }

        let _ = child.kill();
    }
}
