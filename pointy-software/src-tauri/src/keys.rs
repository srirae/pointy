//! Key token vocabulary shared by the keyboard source, the validator and the UI.
//!
//! Every physical key normalises to one stable, human-readable token ("Ctrl", "Shift",
//! "A", "F7"), with left/right modifier pairs collapsed. Tokens are what get persisted,
//! so they must stay stable across releases.

/// Modifier tokens in canonical display order.
pub const MODIFIERS: [&str; 4] = ["Ctrl", "Alt", "Shift", "Win"];

pub fn is_modifier(token: &str) -> bool {
    MODIFIERS.contains(&token)
}

/// Sort key for canonical combo ordering: modifiers first (Ctrl, Alt, Shift, Win),
/// then the single non-modifier key.
pub fn sort_rank(token: &str) -> usize {
    MODIFIERS
        .iter()
        .position(|m| *m == token)
        .unwrap_or(MODIFIERS.len())
}

/// Windows virtual-key codes, grouped so a token can cover more than one key (the two
/// Windows keys, for instance). Order here is irrelevant; the validator canonicalises.
///
/// Deliberately absent: CapsLock, NumLock, ScrollLock, PrintScreen and Pause — binding
/// those produces hotkeys that either wreck normal typing or never fire reliably.
#[cfg(windows)]
pub const WATCHED: &[(&[u16], &str)] = &[
    // modifiers — the combined VKs already cover left and right
    (&[0x11], "Ctrl"),
    (&[0x12], "Alt"),
    (&[0x10], "Shift"),
    (&[0x5B, 0x5C], "Win"),
    (&[0x41], "A"),
    (&[0x42], "B"),
    (&[0x43], "C"),
    (&[0x44], "D"),
    (&[0x45], "E"),
    (&[0x46], "F"),
    (&[0x47], "G"),
    (&[0x48], "H"),
    (&[0x49], "I"),
    (&[0x4A], "J"),
    (&[0x4B], "K"),
    (&[0x4C], "L"),
    (&[0x4D], "M"),
    (&[0x4E], "N"),
    (&[0x4F], "O"),
    (&[0x50], "P"),
    (&[0x51], "Q"),
    (&[0x52], "R"),
    (&[0x53], "S"),
    (&[0x54], "T"),
    (&[0x55], "U"),
    (&[0x56], "V"),
    (&[0x57], "W"),
    (&[0x58], "X"),
    (&[0x59], "Y"),
    (&[0x5A], "Z"),
    (&[0x30], "0"),
    (&[0x31], "1"),
    (&[0x32], "2"),
    (&[0x33], "3"),
    (&[0x34], "4"),
    (&[0x35], "5"),
    (&[0x36], "6"),
    (&[0x37], "7"),
    (&[0x38], "8"),
    (&[0x39], "9"),
    (&[0x70], "F1"),
    (&[0x71], "F2"),
    (&[0x72], "F3"),
    (&[0x73], "F4"),
    (&[0x74], "F5"),
    (&[0x75], "F6"),
    (&[0x76], "F7"),
    (&[0x77], "F8"),
    (&[0x78], "F9"),
    (&[0x79], "F10"),
    (&[0x7A], "F11"),
    (&[0x7B], "F12"),
    (&[0x20], "Space"),
    (&[0x0D], "Enter"),
    (&[0x09], "Tab"),
    (&[0x1B], "Escape"),
    (&[0x08], "Backspace"),
    (&[0x2E], "Delete"),
    (&[0x2D], "Insert"),
    (&[0x24], "Home"),
    (&[0x23], "End"),
    (&[0x21], "PageUp"),
    (&[0x22], "PageDown"),
    (&[0x26], "Up"),
    (&[0x28], "Down"),
    (&[0x25], "Left"),
    (&[0x27], "Right"),
    (&[0xBD], "-"),
    (&[0xBB], "="),
    (&[0xDB], "["),
    (&[0xDD], "]"),
    (&[0xDC], "\\"),
    (&[0xBA], ";"),
    (&[0xDE], "'"),
    (&[0xC0], "`"),
    (&[0xBC], ","),
    (&[0xBE], "."),
    (&[0xBF], "/"),
    (&[0x60], "Num0"),
    (&[0x61], "Num1"),
    (&[0x62], "Num2"),
    (&[0x63], "Num3"),
    (&[0x64], "Num4"),
    (&[0x65], "Num5"),
    (&[0x66], "Num6"),
    (&[0x67], "Num7"),
    (&[0x68], "Num8"),
    (&[0x69], "Num9"),
    (&[0x6A], "Num*"),
    (&[0x6B], "Num+"),
    (&[0x6D], "Num-"),
    (&[0x6F], "Num/"),
];

/// Map an rdev key to its token. Used by the non-Windows keyboard source.
#[cfg(not(windows))]
pub fn token(key: rdev::Key) -> Option<String> {
    use rdev::Key;

    let token = match key {
        Key::ControlLeft | Key::ControlRight => "Ctrl",
        Key::ShiftLeft | Key::ShiftRight => "Shift",
        Key::Alt | Key::AltGr => "Alt",
        Key::MetaLeft | Key::MetaRight => "Win",

        Key::KeyA => "A",
        Key::KeyB => "B",
        Key::KeyC => "C",
        Key::KeyD => "D",
        Key::KeyE => "E",
        Key::KeyF => "F",
        Key::KeyG => "G",
        Key::KeyH => "H",
        Key::KeyI => "I",
        Key::KeyJ => "J",
        Key::KeyK => "K",
        Key::KeyL => "L",
        Key::KeyM => "M",
        Key::KeyN => "N",
        Key::KeyO => "O",
        Key::KeyP => "P",
        Key::KeyQ => "Q",
        Key::KeyR => "R",
        Key::KeyS => "S",
        Key::KeyT => "T",
        Key::KeyU => "U",
        Key::KeyV => "V",
        Key::KeyW => "W",
        Key::KeyX => "X",
        Key::KeyY => "Y",
        Key::KeyZ => "Z",

        Key::Num0 => "0",
        Key::Num1 => "1",
        Key::Num2 => "2",
        Key::Num3 => "3",
        Key::Num4 => "4",
        Key::Num5 => "5",
        Key::Num6 => "6",
        Key::Num7 => "7",
        Key::Num8 => "8",
        Key::Num9 => "9",

        Key::F1 => "F1",
        Key::F2 => "F2",
        Key::F3 => "F3",
        Key::F4 => "F4",
        Key::F5 => "F5",
        Key::F6 => "F6",
        Key::F7 => "F7",
        Key::F8 => "F8",
        Key::F9 => "F9",
        Key::F10 => "F10",
        Key::F11 => "F11",
        Key::F12 => "F12",

        Key::Space => "Space",
        Key::Return | Key::KpReturn => "Enter",
        Key::Tab => "Tab",
        Key::Escape => "Escape",
        Key::Backspace => "Backspace",
        Key::Delete => "Delete",
        Key::Insert => "Insert",
        Key::Home => "Home",
        Key::End => "End",
        Key::PageUp => "PageUp",
        Key::PageDown => "PageDown",
        Key::UpArrow => "Up",
        Key::DownArrow => "Down",
        Key::LeftArrow => "Left",
        Key::RightArrow => "Right",

        Key::Minus => "-",
        Key::Equal => "=",
        Key::LeftBracket => "[",
        Key::RightBracket => "]",
        Key::BackSlash | Key::IntlBackslash => "\\",
        Key::SemiColon => ";",
        Key::Quote => "'",
        Key::BackQuote => "`",
        Key::Comma => ",",
        Key::Dot => ".",
        Key::Slash => "/",

        Key::Kp0 => "Num0",
        Key::Kp1 => "Num1",
        Key::Kp2 => "Num2",
        Key::Kp3 => "Num3",
        Key::Kp4 => "Num4",
        Key::Kp5 => "Num5",
        Key::Kp6 => "Num6",
        Key::Kp7 => "Num7",
        Key::Kp8 => "Num8",
        Key::Kp9 => "Num9",
        Key::KpMultiply => "Num*",
        Key::KpPlus => "Num+",
        Key::KpMinus => "Num-",
        Key::KpDivide => "Num/",

        _ => return None,
    };

    Some(token.to_string())
}
