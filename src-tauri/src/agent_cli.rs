//! Native capabilities for the agent CLIs Canopy knows how to launch.
//!
//! The stable `id` is persistence identity, not a product label or executable.
//! Cross-cutting native features resolve an id here and inspect capabilities;
//! vendor-specific protocol code stays in its owning adapter module.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileIsolation {
    ClaudeConfigDir,
    CodexHome,
    XdgConfigAndData,
    AmpSettingsFile,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccountProbe {
    ClaudeState,
    CodexAuth,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IntegrationAdapter {
    Claude,
    Codex,
    Amp,
    Aider,
    Antigravity,
    OpenCode,
    Omp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentCliManifest {
    pub id: &'static str,
    pub bin: &'static str,
    /// Previous durable ids, if a storage-key migration is ever necessary.
    pub aliases: &'static [&'static str],
    pub profile_isolation: Option<ProfileIsolation>,
    pub account_probe: AccountProbe,
    pub integration: Option<IntegrationAdapter>,
    pub mesh_reader: bool,
}

pub const AGENT_CLIS: &[AgentCliManifest] = &[
    AgentCliManifest {
        id: "claude",
        bin: "claude",
        aliases: &[],
        profile_isolation: Some(ProfileIsolation::ClaudeConfigDir),
        account_probe: AccountProbe::ClaudeState,
        integration: Some(IntegrationAdapter::Claude),
        mesh_reader: true,
    },
    AgentCliManifest {
        id: "codex",
        bin: "codex",
        aliases: &[],
        profile_isolation: Some(ProfileIsolation::CodexHome),
        account_probe: AccountProbe::CodexAuth,
        integration: Some(IntegrationAdapter::Codex),
        mesh_reader: true,
    },
    AgentCliManifest {
        id: "amp",
        bin: "amp",
        aliases: &[],
        profile_isolation: Some(ProfileIsolation::AmpSettingsFile),
        account_probe: AccountProbe::Unknown,
        integration: Some(IntegrationAdapter::Amp),
        mesh_reader: true,
    },
    AgentCliManifest {
        id: "aider",
        bin: "aider",
        aliases: &[],
        profile_isolation: None,
        account_probe: AccountProbe::Unknown,
        integration: Some(IntegrationAdapter::Aider),
        mesh_reader: false,
    },
    AgentCliManifest {
        id: "agy",
        bin: "agy",
        aliases: &[],
        profile_isolation: None,
        account_probe: AccountProbe::Unknown,
        integration: Some(IntegrationAdapter::Antigravity),
        mesh_reader: true,
    },
    AgentCliManifest {
        id: "opencode",
        bin: "opencode",
        aliases: &[],
        profile_isolation: Some(ProfileIsolation::XdgConfigAndData),
        account_probe: AccountProbe::Unknown,
        integration: Some(IntegrationAdapter::OpenCode),
        mesh_reader: true,
    },
    AgentCliManifest {
        id: "omp",
        bin: "omp",
        aliases: &[],
        profile_isolation: None,
        account_probe: AccountProbe::Unknown,
        integration: Some(IntegrationAdapter::Omp),
        mesh_reader: false,
    },
];

pub fn resolve(id: &str) -> Option<&'static AgentCliManifest> {
    AGENT_CLIS
        .iter()
        .find(|cli| cli.id == id || cli.aliases.contains(&id))
}

pub fn profile_clis() -> impl Iterator<Item = &'static AgentCliManifest> {
    AGENT_CLIS
        .iter()
        .filter(|cli| cli.profile_isolation.is_some())
}

pub fn integrated_clis() -> impl Iterator<Item = &'static AgentCliManifest> {
    AGENT_CLIS.iter().filter(|cli| cli.integration.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn durable_ids_and_aliases_are_unique() {
        let mut identities = HashSet::new();
        for cli in AGENT_CLIS {
            assert!(identities.insert(cli.id), "duplicate CLI id {}", cli.id);
            for alias in cli.aliases {
                assert!(identities.insert(*alias), "duplicate CLI alias {alias}");
                assert_eq!(resolve(alias), Some(cli));
            }
            assert_eq!(resolve(cli.id), Some(cli));
        }
    }
}
