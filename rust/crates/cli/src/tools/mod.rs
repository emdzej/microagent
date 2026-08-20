//! Built-in tools, porting `packages/cli/src/tools/`.

mod bash;
mod file_read;
mod file_write;
mod list_dir;

use std::sync::Arc;

use microagent_core::Tool;
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;

/// Truncate tool output at 1 MiB, matching the TypeScript `maxBuffer`.
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

pub fn builtin_tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(file_read::FileReadTool::new()),
        Arc::new(file_write::FileWriteTool::new()),
        Arc::new(bash::BashTool::new()),
        Arc::new(list_dir::ListDirectoryTool::new()),
    ]
}

/// Generate a JSON Schema suitable for an LLM tool definition.
///
/// Three deliberate departures from `schemars`' defaults, all because tool
/// schemas are consumed by model function-calling rather than by a JSON Schema
/// validator:
///
/// * `inline_subschemas` — nested types are inlined instead of hoisted into
///   `$defs`/`$ref`. Several providers, Ollama among them, mishandle `$ref`
///   inside tool parameters. (Do not use recursive argument types: inlining a
///   recursive schema does not terminate.)
/// * `meta_schema: None` — drops the root `$schema` key, which is noise to a
///   model and rejected outright by some strict-mode implementations.
/// * `draft07` — the dialect most function-calling implementations were built
///   against, rather than 2020-12.
///
/// The `title` key is removed for the same reason: it carries the Rust type name,
/// which is meaningless to the model.
pub(crate) fn tool_schema<T: JsonSchema>() -> serde_json::Value {
    let settings = SchemaSettings::draft07().with(|s| {
        s.inline_subschemas = true;
        s.meta_schema = None;
    });

    let schema = settings.into_generator().into_root_schema_for::<T>();
    let mut value =
        serde_json::to_value(schema).unwrap_or_else(|_| serde_json::json!({ "type": "object" }));

    if let Some(obj) = value.as_object_mut() {
        obj.remove("title");
    }
    value
}

/// Truncate a string to at most `MAX_OUTPUT_BYTES`, on a character boundary.
pub(crate) fn truncate_output(mut s: String) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        return s;
    }
    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n[output truncated]");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_tool_has_a_name_and_description() {
        for tool in builtin_tools() {
            let d = tool.definition();
            assert!(!d.name.is_empty());
            assert!(!d.description.is_empty(), "{} has no description", d.name);
        }
    }

    #[test]
    fn builtin_tool_names_match_the_typescript_set() {
        let mut names: Vec<_> = builtin_tools()
            .iter()
            .map(|t| t.definition().name.clone())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["bash", "file_read", "file_write", "list_directory"]
        );
    }

    /// The load-bearing schema assertion. `$defs`/`$ref` in tool parameters
    /// breaks function-calling on several providers, and `$schema` is rejected by
    /// some strict modes. This must not regress silently.
    #[test]
    fn no_tool_schema_contains_defs_refs_or_a_meta_schema() {
        for tool in builtin_tools() {
            let d = tool.definition();
            let text = d.input_schema.to_string();
            for forbidden in ["$defs", "$ref", "$schema", "definitions"] {
                assert!(
                    !text.contains(forbidden),
                    "{} schema contains {forbidden}: {text}",
                    d.name
                );
            }
        }
    }

    #[test]
    fn every_tool_schema_is_a_closed_object() {
        for tool in builtin_tools() {
            let d = tool.definition();
            let schema = &d.input_schema;
            assert_eq!(
                schema["type"], "object",
                "{} schema is not an object",
                d.name
            );
            // deny_unknown_fields on the arg struct produces this, which strict
            // function-calling modes require.
            assert_eq!(
                schema["additionalProperties"],
                serde_json::json!(false),
                "{} schema is not closed",
                d.name
            );
            assert!(
                schema["properties"].is_object(),
                "{} schema has no properties",
                d.name
            );
        }
    }

    #[test]
    fn truncation_appends_a_marker_and_respects_char_boundaries() {
        let short = "hello".to_string();
        assert_eq!(truncate_output(short.clone()), short);

        // Multi-byte characters straddling the cut must not panic or corrupt.
        let long = "é".repeat(MAX_OUTPUT_BYTES);
        let out = truncate_output(long);
        assert!(out.ends_with("[output truncated]"));
        assert!(out.is_char_boundary(out.len() - "\n[output truncated]".len()));
    }
}
