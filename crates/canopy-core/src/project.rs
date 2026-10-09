//! The project an agent request is scoped to, as the embedding process
//! resolved it. Notes and research are partitioned by `id`; `name` and `roots`
//! are recorded beside them so an orphaned id stays recoverable.

#[derive(Clone, Copy, Debug)]
pub struct Project<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub roots: &'a [String],
}
