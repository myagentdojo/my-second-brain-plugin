---
name: new-plugin
description: "Prepare a separate, approval-gated bootstrap plan for a new Agent Plugin Template repository."
disable-model-invocation: true
---

# New Plugin

Use this skill only when the user explicitly invokes `$new-plugin`. It is a
thin pointer for creating a Plugin Repository from the Agent Plugin Template.
Read the template README section `Create a plugin repository` for the
bootstrap owner and mechanics. Do not copy those mechanics into this skill.

Gather the proposed plugin identity and destination before preparing the
preview:

- plugin name and display name;
- author and repository identity;
- destination directory or clone target; and
- the selected Agent Plugin Template source.

Show one exact bootstrap preview before any external or filesystem mutation.
Name the template, clone or init destination, identity initialization, locked
dependency installation, generated validation, expected files, effects, and
exclusions. State that the preview covers template/clone/init/validation
effects only. Exclude skill formation, payload implementation, runtime
changes, harness installation, activation, release, and cleanup.

Request a dedicated New Plugin approval. Keep it separate from Formation
approval and any later development or release approval. After presenting the
preview and recording the decision, stop before actual bootstrap. The approved
preview is input to a later Plugin Creator handoff; this stub does not call it.
A proposed command, approval, or validation plan is not a created Plugin
Repository.
