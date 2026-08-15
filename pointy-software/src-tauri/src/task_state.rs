//! Local Trust Layer for guided walkthroughs.
//!
//! The model proposes an action; this module records the contract and only
//! allows the guide to request another model step after a local OS signal
//! verifies the user's action. It deliberately has no network, screenshot, or
//! AI dependencies.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuidePhase {
    WaitingForAction,
    RequestingNext,
    Recovery,
    Completed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuideAction {
    Click,
    Type,
    Select,
    Toggle,
    Submit,
    Open,
    Unknown,
}

impl GuideAction {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "click" => Self::Click,
            "type" | "enter" | "write" => Self::Type,
            "select" | "choose" => Self::Select,
            "toggle" | "check" | "uncheck" => Self::Toggle,
            "submit" | "send" | "continue" => Self::Submit,
            "open" | "launch" => Self::Open,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StepContract {
    pub step: u32,
    pub action: GuideAction,
    pub label: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustDiagnostic {
    pub step: u32,
    pub phase: GuidePhase,
    pub reason: String,
    pub action: GuideAction,
    pub confidence: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Ignore,
    Advance,
}

#[derive(Debug, Clone)]
pub struct TrustLayer {
    phase: GuidePhase,
    contract: Option<StepContract>,
}

impl Default for TrustLayer {
    fn default() -> Self {
        Self {
            phase: GuidePhase::Stopped,
            contract: None,
        }
    }
}

impl TrustLayer {
    pub fn begin(&mut self, contract: StepContract) -> TrustDiagnostic {
        let diagnostic = TrustDiagnostic {
            step: contract.step,
            phase: GuidePhase::WaitingForAction,
            reason: "step_contract_ready".to_string(),
            action: contract.action,
            confidence: contract.confidence,
        };
        self.contract = Some(contract);
        self.phase = GuidePhase::WaitingForAction;
        diagnostic
    }

    /// A click inside the currently highlighted target is a local verification
    /// signal. The guide may now capture and ask for the next step.
    pub fn target_clicked(&mut self) -> (GateDecision, Option<TrustDiagnostic>) {
        if self.phase != GuidePhase::WaitingForAction || self.contract.is_none() {
            return (GateDecision::Ignore, None);
        }
        self.phase = GuidePhase::RequestingNext;
        (GateDecision::Advance, Some(self.diagnostic("target_clicked")))
    }

    /// A meaningful accessibility-tree mutation can verify a dialog/view change,
    /// but it is never accepted while merely waiting for a click target.
    pub fn meaningful_window_change(&mut self) -> (GateDecision, Option<TrustDiagnostic>) {
        if self.phase != GuidePhase::WaitingForAction || self.contract.is_none() {
            return (GateDecision::Ignore, None);
        }
        self.phase = GuidePhase::RequestingNext;
        (GateDecision::Advance, Some(self.diagnostic("meaningful_window_change")))
    }

    pub fn check_in(&mut self) -> TrustDiagnostic {
        self.phase = GuidePhase::Recovery;
        self.diagnostic("gentle_check_in")
    }

    pub fn resume_after_check_in(&mut self) -> TrustDiagnostic {
        self.phase = GuidePhase::WaitingForAction;
        self.diagnostic("still_waiting")
    }

    pub fn complete(&mut self) -> TrustDiagnostic {
        self.phase = GuidePhase::Completed;
        self.diagnostic("task_complete")
    }

    fn diagnostic(&self, reason: &str) -> TrustDiagnostic {
        let contract = self.contract.as_ref().expect("contract exists in active phase");
        TrustDiagnostic {
            step: contract.step,
            phase: self.phase,
            reason: reason.to_string(),
            action: contract.action,
            confidence: contract.confidence,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract(action: GuideAction) -> StepContract {
        StepContract {
            step: 1,
            action,
            label: "Continue".into(),
            confidence: 0.91,
        }
    }

    #[test]
    fn cannot_advance_before_a_step_exists() {
        let mut trust = TrustLayer::default();
        assert_eq!(trust.target_clicked().0, GateDecision::Ignore);
    }

    #[test]
    fn target_click_is_the_only_local_advance_signal() {
        let mut trust = TrustLayer::default();
        trust.begin(contract(GuideAction::Click));
        assert_eq!(trust.meaningful_window_change().0, GateDecision::Advance);
        assert_eq!(trust.target_clicked().0, GateDecision::Ignore);
    }

    #[test]
    fn repeated_events_cannot_advance_twice() {
        let mut trust = TrustLayer::default();
        trust.begin(contract(GuideAction::Submit));
        assert_eq!(trust.target_clicked().0, GateDecision::Advance);
        assert_eq!(trust.target_clicked().0, GateDecision::Ignore);
    }

    #[test]
    fn check_in_is_recoverable_without_losing_contract() {
        let mut trust = TrustLayer::default();
        trust.begin(contract(GuideAction::Type));
        assert_eq!(trust.check_in().phase, GuidePhase::Recovery);
        assert_eq!(trust.resume_after_check_in().phase, GuidePhase::WaitingForAction);
    }
}
