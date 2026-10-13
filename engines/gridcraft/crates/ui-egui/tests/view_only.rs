//! A workbook open for viewing only (`Session::read_only`) gets no cell editor: typing, F2 and
//! the formula bar leave the cell alone instead of starting an edit that would be refused.
use gridcraft_engine::Session;
use gridcraft_ui_egui::SheetApp;
use serde_json::json;

#[test]
fn viewing_only_opens_no_cell_editor() {
    let mut session = Session::default();
    session.new_workbook();
    let mut app = SheetApp::new(session, Default::default());
    app.run("cell.set", json!({"cell": "A1", "input": "kept"})).unwrap();
    app.session.read_only = true;
    app.begin_edit(Some("typed".into()), false);
    assert!(app.editor.is_none(), "typing must not open the editor while viewing");
    app.begin_edit(None, true);
    assert!(app.editor.is_none(), "F2 or the formula bar must not open it either");
    app.session.read_only = false;
    app.begin_edit(Some("typed".into()), false);
    assert!(app.editor.is_some());
}
