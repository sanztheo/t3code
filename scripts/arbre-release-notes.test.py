import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "arbre_release_notes", Path(__file__).with_name("arbre-release-notes.py")
)
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)


class ReleaseNotesTest(unittest.TestCase):
    def test_rejects_the_structured_commit_titles_published_in_build_33(self):
        with self.assertRaises(ValueError):
            notes.format_highlights([
                '{"notes officielles": "feat(web): copy a chat table as PNG (#43435)"}'
            ], 1)

    def test_rejects_english_titles_and_build_metadata(self):
        for line in [
            "fix(web): keep a moved draft in its new workspace (#43865)",
            "Les fichiers keep their old names.",
            "Les changements du build arbre: 1234567 sont disponibles.",
        ]:
            with self.subTest(line=line), self.assertRaises(ValueError):
                notes.format_highlights([line], 1)

    def test_formats_french_user_notes(self):
        self.assertEqual(
            notes.format_highlights(["Vous pouvez copier un tableau en image."], 1),
            "- Vous pouvez copier un tableau en image.",
        )
        self.assertEqual(notes.format_highlights([], 0), notes.NO_CHANGES)

    def test_rejects_repeated_or_extra_translations_from_build_34(self):
        line = "La commande /compact respecte l’historique du fil."
        with self.assertRaises(ValueError):
            notes.format_highlights([line] * 4, 4)
        with self.assertRaises(ValueError):
            notes.format_highlights([line], 2)

    def test_a_rejected_translation_points_to_the_changelog_instead_of_blocking(self):
        self.assertEqual(
            notes.translated_highlights('["Choisissez une note interne."][end of text]', 1),
            notes.UNTRANSLATED,
        )
        self.assertEqual(notes.translated_highlights("not json", 1), notes.UNTRANSLATED)
        self.assertEqual(
            notes.translated_highlights('["Vous pouvez copier un tableau en image."]', 1),
            "- Vous pouvez copier un tableau en image.",
        )

    def test_translation_sources_have_no_commit_wrapper_or_example(self):
        self.assertEqual(
            notes.translation_sources(["fix(web): keep numbered lists (#44318)"], ""),
            ["keep numbered lists"],
        )
        self.assertEqual(
            notes.translation_sources([], "- **Files.** Download files.\n- **Mobile.** Change fonts."),
            ["Files. Download files."],
        )

    def test_limits_sources_and_prioritizes_features(self):
        changes = [f"fix(web): correction {index}" for index in range(10)]
        changes += ["feat(web): download files", changes[0]]
        selected = notes.select_changes(changes)
        self.assertEqual(len(selected), 7)
        self.assertEqual(selected[0], "feat(web): download files")
        self.assertEqual(len(selected), len(set(selected)))

    def test_fork_publisher_maintenance_is_not_a_desktop_feature(self):
        self.assertFalse(notes.desktop_subject("arbre: improve release notes", fork=True))
        self.assertFalse(notes.desktop_subject("fix(release): repair launch check"))
        self.assertFalse(notes.desktop_subject("feat(mobile): change fonts"))


if __name__ == "__main__":
    unittest.main()
