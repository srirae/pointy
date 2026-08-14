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
    IUIAutomationTogglePattern, TreeScope_Descendants, ToggleState_On, UIA_ButtonControlTypeId,
    UIA_CheckBoxControlTypeId, UIA_ComboBoxControlTypeId, UIA_EditControlTypeId,
    UIA_HyperlinkControlTypeId, UIA_ListItemControlTypeId, UIA_MenuItemControlTypeId,
    UIA_RadioButtonControlTypeId, UIA_TabItemControlTypeId, UIA_TogglePatternId,
    UIA_TreeItemControlTypeId,
};

#[cfg(windows)]
use crate::capture::AskCapture;
#[cfg(windows)]
use crate::nim::ClickTarget;

/// How many descendants we are willing to walk while matching. Browsers expose
/// huge trees; past this we give up and keep the model's box.
#[cfg(windows)]
const MAX_ELEMENTS: i32 = 3000;

/// A cheap snapshot of the accessibility tree, used by Guide Mode to notice
/// locally — with no AI call — that a step was completed.
#[cfg(windows)]
#[derive(Debug, Clone)]
pub struct UiSnapshot {
    pub title: String,
    pub focus: String,
    pub toggled: Vec<String>,
    pub count: i32,
}

#[cfg(not(windows))]
#[derive(Debug, Clone)]
pub struct UiSnapshot {
    pub title: String,
    pub focus: String,
    pub toggled: Vec<String>,
    pub count: i32,
}

#[cfg(not(windows))]
pub fn snapshot(_window_id: Option<u32>) -> Option<UiSnapshot> {
    None
}

#[cfg(windows)]
/// Capture the current accessibility state of a window. None when the window
/// has no usable UIA tree (the caller falls back to click detection).
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
        let focus = automation
            .GetFocusedElement()
            .ok()
            .and_then(|element| element.CurrentName().ok())
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
            focus,
            toggled,
            count,
        })
    }
}

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

/// Refine `target` (shot-relative fractions) using the element whose name best
/// matches `target.label`. Returns shot-relative fractions, or None to keep the
/// model's box.
#[cfg(windows)]
pub fn refine(window_id: u32, shot: &AskCapture, target: &ClickTarget) -> Option<ClickTarget> {
    let (mx, my, mw, mh) = primary_monitor_px()?;
    let rect = find_rect(window_id, &target.label)?;

    // UIA rects are physical screen pixels; fold onto primary-monitor fractions.
    let fx = (rect.left as f64 - mx as f64) / mw as f64;
    let fy = (rect.top as f64 - my as f64) / mh as f64;
    let fw = ((rect.right - rect.left) as f64) / mw as f64;
    let fh = ((rect.bottom - rect.top) as f64) / mh as f64;
    if fx < -0.05 || fy < -0.05 || fx > 1.05 || fy > 1.05 || fw <= 0.0 || fh <= 0.0 {
        return None;
    }

    // Monitor fractions -> fractions of the captured crop, the same space the
    // model's box and the frontend mapping already use.
    let sx = (fx - shot.x) / shot.w;
    let sy = (fy - shot.y) / shot.h;
    let sw = fw / shot.w;
    let sh = fh / shot.h;
    if sx < -0.05 || sy < -0.05 || sx > 1.05 || sy > 1.05 {
        return None;
    }

    Some(ClickTarget {
        label: target.label.clone(),
        x: sx.clamp(0.0, 1.0),
        y: sy.clamp(0.0, 1.0),
        w: sw.clamp(0.0, 1.0),
        h: sh.clamp(0.0, 1.0),
    })
}

#[cfg(windows)]
fn primary_monitor_px() -> Option<(i32, i32, i32, i32)> {
    let monitor = xcap::Monitor::all()
        .ok()?
        .into_iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| xcap::Monitor::all().ok().and_then(|all| all.into_iter().next()))?;
    Some((
        monitor.x().ok()?,
        monitor.y().ok()?,
        monitor.width().ok()? as i32,
        monitor.height().ok()? as i32,
    ))
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
