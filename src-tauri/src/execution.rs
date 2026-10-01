use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const VERSION: u8 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContext {
    pub environment_id: String,
    pub project_id: String,
    pub component_id: Option<String>,
    pub workspace_id: String,
    pub workspace_path: String,
    pub run_id: Option<String>,
    pub attempt_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    id: String,
    project_id: String,
    component_id: Option<String>,
    path: String,
}

#[derive(Default, Deserialize, Serialize)]
struct WorkspaceFile {
    version: u8,
    workspaces: Vec<WorkspaceRecord>,
}

#[derive(Default)]
struct RegistryState {
    environment_id: Option<String>,
    workspaces: Option<Vec<WorkspaceRecord>>,
}

pub struct ExecutionRegistry {
    state: Mutex<RegistryState>,
    root: Option<PathBuf>,
}

impl Default for ExecutionRegistry {
    fn default() -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            root: None,
        }
    }
}

impl ExecutionRegistry {
    pub fn environment_id(&self) -> Result<String, String> {
        let mut state = self.state.lock().unwrap();
        self.environment_id_locked(&mut state)
    }

    pub fn bind(
        &self,
        project_id: Option<&str>,
        component_id: Option<&str>,
        workspace_path: Option<&str>,
        task: Option<&crate::tasks::AttemptBinding>,
    ) -> Result<Option<ExecutionContext>, String> {
        let Some(project_id) = clean(project_id, 256, "project id")? else {
            return Ok(None);
        };
        let component_id = clean(component_id, 256, "component id")?;
        let path = clean(workspace_path, 4096, "workspace path")?
            .ok_or_else(|| "workspace path is required with a project id".to_string())?;
        let path = normalize_path(&path)?;

        let mut state = self.state.lock().unwrap();
        let environment_id = self.environment_id_locked(&mut state)?;
        if state.workspaces.is_none() {
            state.workspaces = Some(load_workspaces(&self.base_dir()?)?);
        }
        let workspaces = state.workspaces.as_mut().unwrap();
        let found = workspaces.iter().find(|workspace| {
            workspace.project_id == project_id
                && workspace.component_id == component_id
                && workspace.path == path
        });
        let workspace_id = match found {
            Some(workspace) => workspace.id.clone(),
            None => {
                let workspace = WorkspaceRecord {
                    id: random_id("ws")?,
                    project_id: project_id.clone(),
                    component_id: component_id.clone(),
                    path: path.clone(),
                };
                let id = workspace.id.clone();
                workspaces.push(workspace);
                save_workspaces(&self.base_dir()?, workspaces)?;
                id
            }
        };

        Ok(Some(ExecutionContext {
            environment_id,
            project_id,
            component_id,
            workspace_id,
            workspace_path: path,
            run_id: task.map(|binding| binding.run_id.clone()),
            attempt_id: task.map(|binding| binding.attempt_id.clone()),
        }))
    }

    fn environment_id_locked(&self, state: &mut RegistryState) -> Result<String, String> {
        if let Some(id) = &state.environment_id {
            return Ok(id.clone());
        }
        let id = load_or_create_environment_id(&self.base_dir()?)?;
        state.environment_id = Some(id.clone());
        Ok(id)
    }

    fn base_dir(&self) -> Result<PathBuf, String> {
        if let Some(root) = &self.root {
            return Ok(root.clone());
        }
        if let Some(root) = crate::selftest::store_dir() {
            return Ok(root.clone());
        }
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "no home dir".to_string())?;
        Ok(PathBuf::from(home).join(".canopy"))
    }

    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self {
            state: Mutex::new(RegistryState::default()),
            root: Some(root),
        }
    }
}

#[tauri::command]
pub fn environment_identity(
    registry: tauri::State<'_, ExecutionRegistry>,
) -> Result<String, String> {
    registry.environment_id()
}

fn clean(value: Option<&str>, max: usize, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.contains('\0') {
        return Err(format!("invalid {label}"));
    }
    Ok(Some(value.to_string()))
}

fn normalize_path(path: &str) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("workspace path must be absolute".into());
    }
    let normalized = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(normalized
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string())
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(format!("{prefix}_{}", hex::encode(bytes)))
}

fn valid_id(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|tail| tail.len() == 32 && tail.chars().all(|c| c.is_ascii_hexdigit()))
}

fn load_or_create_environment_id(root: &Path) -> Result<String, String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join("environment-id");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let id = raw.trim();
        return valid_id(id, "env_")
            .then(|| id.to_string())
            .ok_or_else(|| format!("{} contains an invalid environment id", path.display()));
    }
    let id = random_id("env")?;
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            writeln!(file, "{id}").map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            Ok(id)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            load_or_create_environment_id(root)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn load_workspaces(root: &Path) -> Result<Vec<WorkspaceRecord>, String> {
    let path = root.join("workspaces.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let file: WorkspaceFile = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if file.version != VERSION
        || file.workspaces.iter().any(|workspace| {
            !valid_id(&workspace.id, "ws_") || !Path::new(&workspace.path).is_absolute()
        })
    {
        return Err(format!(
            "{} is not a valid workspace registry",
            path.display()
        ));
    }
    Ok(file.workspaces)
}

fn save_workspaces(root: &Path, workspaces: &[WorkspaceRecord]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join("workspaces.json");
    let temp = root.join(format!(".workspaces-{}.tmp", random_id("write")?));
    let body = serde_json::to_vec_pretty(&WorkspaceFile {
        version: VERSION,
        workspaces: workspaces.to_vec(),
    })
    .map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(&body).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        let backup = root.join("workspaces.json.bak");
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&path, &backup).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temp, &path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(random_id("canopy-execution-test").unwrap())
    }

    #[test]
    fn environment_and_workspace_ids_survive_registry_reloads() {
        let root = root();
        let workspace = root.join("repo");
        std::fs::create_dir_all(&workspace).unwrap();
        let first = ExecutionRegistry::at(root.clone());
        let context = first
            .bind(Some("project"), Some("component"), workspace.to_str(), None)
            .unwrap()
            .unwrap();
        let second = ExecutionRegistry::at(root);
        let restored = second
            .bind(Some("project"), Some("component"), workspace.to_str(), None)
            .unwrap()
            .unwrap();
        assert_eq!(context.environment_id, restored.environment_id);
        assert_eq!(context.workspace_id, restored.workspace_id);
    }

    #[test]
    fn workspace_identity_is_scoped_by_project_and_component() {
        let root = root();
        let workspace = root.join("repo");
        std::fs::create_dir_all(&workspace).unwrap();
        let registry = ExecutionRegistry::at(root);
        let a = registry
            .bind(Some("a"), Some("web"), workspace.to_str(), None)
            .unwrap()
            .unwrap();
        let b = registry
            .bind(Some("b"), Some("web"), workspace.to_str(), None)
            .unwrap()
            .unwrap();
        assert_ne!(a.workspace_id, b.workspace_id);
    }
}
