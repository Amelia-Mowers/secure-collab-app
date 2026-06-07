//! Cell type and Last-Write-Wins resolution logic.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// A unique identifier for a cell in the table system.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CellId {
    pub table_id: String,
    pub row_id: String,
    pub column_id: String,
}

impl CellId {
    pub fn new(
        table_id: impl Into<String>,
        row_id: impl Into<String>,
        column_id: impl Into<String>,
    ) -> Self {
        Self {
            table_id: table_id.into(),
            row_id: row_id.into(),
            column_id: column_id.into(),
        }
    }
}

/// A cell value with LWW timestamp for conflict resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cell {
    pub id: CellId,
    pub value: serde_json::Value,
    pub timestamp: u64,
    /// Server timestamp for tie-breaking when logical timestamps match
    pub server_timestamp: Option<u64>,
}

impl Cell {
    pub fn new(id: CellId, value: serde_json::Value, timestamp: u64) -> Self {
        Self {
            id,
            value,
            timestamp,
            server_timestamp: None,
        }
    }

    pub fn with_server_timestamp(mut self, server_timestamp: u64) -> Self {
        self.server_timestamp = Some(server_timestamp);
        self
    }

    /// Determines which cell wins in a Last-Write-Wins conflict.
    /// Returns the cell with the higher timestamp. If timestamps are equal,
    /// uses server timestamp as a tie-breaker.
    pub fn resolve_lww<'a>(&'a self, other: &'a Cell) -> &'a Cell {
        match self.timestamp.cmp(&other.timestamp) {
            Ordering::Greater => self,
            Ordering::Less => other,
            Ordering::Equal => {
                // Tie-breaker: use server timestamp if available
                match (self.server_timestamp, other.server_timestamp) {
                    (Some(st1), Some(st2)) => {
                        if st1 >= st2 {
                            self
                        } else {
                            other
                        }
                    }
                    (Some(_), None) => self,
                    (None, Some(_)) => other,
                    (None, None) => self, // Arbitrary but deterministic
                }
            }
        }
    }

    /// Checks if this cell should win over another cell based on LWW.
    pub fn wins_over(&self, other: &Cell) -> bool {
        std::ptr::eq(self.resolve_lww(other), self)
    }
}

/// Current wire format version for cell updates.
pub const CELL_UPDATE_VERSION: u8 = 1;

fn default_version() -> u8 {
    CELL_UPDATE_VERSION
}

/// A cell update event that can be sent over Matrix.
///
/// The `version` field is included for forward compatibility: old clients
/// ignore fields they don't understand, and new clients can detect older
/// event formats. Defaults to [`CELL_UPDATE_VERSION`] on construction
/// and deserialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellUpdate {
    /// Wire format version (defaults to 1).
    #[serde(default = "default_version")]
    pub version: u8,
    pub table_id: String,
    pub row_id: String,
    pub column_id: String,
    pub value: serde_json::Value,
    pub timestamp: u64,
    /// Server-assigned timestamp (Matrix `origin_server_ts`, in ms) used purely
    /// as a deterministic tiebreaker when two updates share the same logical
    /// `timestamp`. It is **never serialized to the wire** — the receiver fills
    /// it in from the Matrix event envelope. `None` for local writes.
    #[serde(skip)]
    pub server_timestamp: Option<u64>,
}

impl CellUpdate {
    pub fn new(
        table_id: impl Into<String>,
        row_id: impl Into<String>,
        column_id: impl Into<String>,
        value: serde_json::Value,
        timestamp: u64,
    ) -> Self {
        Self {
            version: CELL_UPDATE_VERSION,
            table_id: table_id.into(),
            row_id: row_id.into(),
            column_id: column_id.into(),
            value,
            timestamp,
            server_timestamp: None,
        }
    }

    /// Attach a server timestamp, used as the LWW tiebreaker when two updates
    /// share the same logical `timestamp`.
    pub fn with_server_timestamp(mut self, server_timestamp: u64) -> Self {
        self.server_timestamp = Some(server_timestamp);
        self
    }

    pub fn to_cell(&self) -> Cell {
        let mut cell = Cell::new(
            CellId::new(&self.table_id, &self.row_id, &self.column_id),
            self.value.clone(),
            self.timestamp,
        );
        cell.server_timestamp = self.server_timestamp;
        cell
    }

    /// Convert to Cell by consuming self (avoids clones)
    pub fn into_cell(self) -> Cell {
        let server_timestamp = self.server_timestamp;
        let mut cell = Cell::new(
            CellId::new(self.table_id, self.row_id, self.column_id),
            self.value,
            self.timestamp,
        );
        cell.server_timestamp = server_timestamp;
        cell
    }

    pub fn cell_id(&self) -> CellId {
        CellId::new(&self.table_id, &self.row_id, &self.column_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_lww_resolution_newer_wins() {
        let cell1 = Cell::new(
            CellId::new("table1", "row1", "col1"),
            json!("old value"),
            100,
        );
        let cell2 = Cell::new(
            CellId::new("table1", "row1", "col1"),
            json!("new value"),
            200,
        );

        assert!(cell2.wins_over(&cell1));
        assert!(!cell1.wins_over(&cell2));
    }

    #[test]
    fn test_lww_resolution_server_timestamp_tiebreaker() {
        let cell1 = Cell::new(CellId::new("table1", "row1", "col1"), json!("value1"), 100)
            .with_server_timestamp(1000);

        let cell2 = Cell::new(CellId::new("table1", "row1", "col1"), json!("value2"), 100)
            .with_server_timestamp(2000);

        assert!(cell2.wins_over(&cell1));
        assert!(!cell1.wins_over(&cell2));
    }

    #[test]
    fn test_cell_update_conversion() {
        let update = CellUpdate::new("table1", "row1", "col1", json!("test"), 123);
        let cell = update.to_cell();

        assert_eq!(cell.id.table_id, "table1");
        assert_eq!(cell.id.row_id, "row1");
        assert_eq!(cell.id.column_id, "col1");
        assert_eq!(cell.value, json!("test"));
        assert_eq!(cell.timestamp, 123);
    }

    #[test]
    fn test_cell_update_carries_server_timestamp_into_cell() {
        let update = CellUpdate::new("t", "r", "c", json!("x"), 1).with_server_timestamp(42);
        assert_eq!(update.to_cell().server_timestamp, Some(42));
        assert_eq!(update.into_cell().server_timestamp, Some(42));
    }

    #[test]
    fn test_server_timestamp_is_not_serialized() {
        // server_timestamp is receiver-local metadata and must never go on the wire.
        let update = CellUpdate::new("t", "r", "c", json!("x"), 1).with_server_timestamp(42);
        let json = serde_json::to_value(&update).unwrap();
        assert!(json.get("server_timestamp").is_none());
        // And it round-trips back to None on deserialize.
        let back: CellUpdate = serde_json::from_value(json).unwrap();
        assert_eq!(back.server_timestamp, None);
    }
}
