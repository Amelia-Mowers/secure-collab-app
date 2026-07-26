//! The shipped workspace templates are data, not code (ADR 0004) — which means
//! nothing type-checks them. This test is what stands in for that: every
//! template directory under `ui/src/templates/` must parse, and the demo (the
//! one with rows and cross-table references) must actually materialize.
//!
//! Without this, a typo in a checked-in CSV would ship and only surface as a
//! broken "New workspace" dialogue.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use app_core::archive::{Archive, Files};
use app_core::Workspace;

fn templates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/src/templates")
}

/// Read one template directory into the archive's `path -> contents` map.
fn read_template(dir: &Path) -> Files {
    let mut files = Files::new();
    fn walk(root: &Path, dir: &Path, files: &mut Files) {
        for entry in std::fs::read_dir(dir).expect("readable template directory") {
            let path = entry.expect("readable entry").path();
            if path.is_dir() {
                walk(root, &path, files);
            } else if path.extension().is_some_and(|e| e == "csv") {
                let rel = path
                    .strip_prefix(root)
                    .expect("under root")
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(rel, std::fs::read_to_string(&path).expect("utf-8 csv"));
            }
        }
    }
    walk(dir, dir, &mut files);
    files
}

fn all_templates() -> BTreeMap<String, Files> {
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(templates_dir()).expect("ui/src/templates exists") {
        let path = entry.expect("readable entry").path();
        if path.is_dir() {
            let slug = path.file_name().unwrap().to_string_lossy().to_string();
            out.insert(slug, read_template(&path));
        }
    }
    out
}

#[test]
fn every_shipped_template_parses_and_is_described() {
    let templates = all_templates();
    assert!(!templates.is_empty(), "no templates found");

    for (slug, files) in &templates {
        let archive = Archive::from_files(files)
            .unwrap_or_else(|e| panic!("template {slug:?} does not parse: {e}"));
        assert!(!archive.name.is_empty(), "template {slug:?} has no name");
        assert!(
            !archive.description.is_empty(),
            "template {slug:?} has no description — the gallery would show a blank card"
        );
        assert!(
            !archive.tables.is_empty(),
            "template {slug:?} defines no tables"
        );
        for table in &archive.tables {
            assert!(
                !table.columns.is_empty(),
                "template {slug:?} table {:?} has no columns",
                table.id
            );
        }
    }
}

#[test]
fn every_shipped_template_applies_cleanly() {
    for (slug, files) in &all_templates() {
        let archive = Archive::from_files(files).expect("parses");
        let mut ws = Workspace::new("test");
        let result = archive.apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));
        assert_eq!(
            result.issues,
            Vec::new(),
            "template {slug:?} produced import issues"
        );
        for table in &archive.tables {
            assert!(
                ws.get_table_schema(&table.id).is_some(),
                "template {slug:?} did not create table {:?}",
                table.id
            );
        }
    }
}

#[test]
fn the_demo_template_seeds_rows_and_resolves_its_references() {
    let files = all_templates().remove("demo").expect("a demo template");
    let archive = Archive::from_files(&files).expect("parses");
    let mut ws = Workspace::new("test");
    let result = archive.apply_to_workspace(&mut ws, &mut |t, r| format!("row_{t}_{r}"));
    assert_eq!(result.issues, Vec::new());

    let contacts = ws.get_table_rows("contacts").expect("contacts table");
    assert_eq!(contacts.len(), 4);
    let tasks = ws.get_table_rows("tasks").expect("tasks table");
    assert_eq!(tasks.len(), 8);

    // The demo exists to show both reference arities on real data (issue
    // 341282fe), so a label in the CSV must have become a real row id.
    let dana = contacts
        .iter()
        .find(|r| r["name"] == "Dana Whitfield")
        .expect("Dana");
    let dana_id = dana["_row_id"].as_str().unwrap();

    let hero = tasks
        .iter()
        .find(|r| r["title"] == "Sketch landing page hero")
        .expect("the hero task");
    assert_eq!(hero["client"], serde_json::json!(dana_id));
    let stakeholders = hero["stakeholders"].as_array().expect("multireference");
    assert_eq!(stakeholders.len(), 2);
    assert!(stakeholders.contains(&serde_json::json!(dana_id)));

    // Two boards, one of them the per-viewer `@me` filter.
    assert_eq!(archive.views.len(), 2);
    let mine = archive
        .views
        .iter()
        .find(|v| v.id == "tasks-mine")
        .expect("My Board");
    assert_eq!(mine.filters.len(), 1);
    assert_eq!(mine.filters[0].value, Some(serde_json::json!("@me")));
}
