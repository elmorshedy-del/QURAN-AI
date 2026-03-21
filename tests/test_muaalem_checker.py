from __future__ import annotations

from server.main import _collapse_word_level_errors
from server.muaalem_checker import MuaalemChecker, TajweedError, classify_phoneme_error


def test_classify_phoneme_error_detects_tafkheem_pair() -> None:
    error_type, rule, description = classify_phoneme_error("s", "sˤ")
    assert error_type == "tafkheem"
    assert rule == "tafkheem/tarqeeq"
    assert "ص sounds like س" in description


def test_align_and_compare_marks_substitution() -> None:
    checker = MuaalemChecker.__new__(MuaalemChecker)
    errors = checker.align_and_compare(["s"], ["sˤ"])
    assert len(errors) == 1
    assert errors[0]["error_type"] == "tafkheem"


def test_get_expected_phonemes_falls_back_to_tokenizer() -> None:
    checker = MuaalemChecker.__new__(MuaalemChecker)
    checker._phonemizer = None

    class _Tokenizer:
        @staticmethod
        def tokenize(word: str):
            return [f"tok:{word}"]

    class _Processor:
        tokenizer = _Tokenizer()

    checker.processor = _Processor()
    phonemes = checker.get_expected_phonemes(["بِسْمِ", "ٱللَّهِ"])
    assert phonemes == ["tok:بِسْمِ", "tok:ٱللَّهِ"]


def test_postprocess_results_filters_generic_alignment_noise() -> None:
    checker = MuaalemChecker.__new__(MuaalemChecker)
    results = [
        TajweedError(
            word_index=0,
            expected_phoneme="ʔ",
            predicted_phoneme="(skipped)",
            error_type="missing",
            rule="missing_sound",
            description_en="Sound [ءَ] was skipped",
            description_ar="",
            severity="high",
            confidence=0.95,
        ),
        TajweedError(
            word_index=0,
            expected_phoneme="a",
            predicted_phoneme="i",
            error_type="vowel",
            rule="harakat",
            description_en="Kasra read as fatha",
            description_ar="",
            severity="medium",
            confidence=0.95,
        ),
        TajweedError(
            word_index=1,
            expected_phoneme="aː",
            predicted_phoneme="a",
            error_type="madd",
            rule="Madd",
            description_en="Madd not elongated",
            description_ar="",
            severity="medium",
            confidence=0.95,
        ),
    ]

    filtered = checker._postprocess_results(results, ["الْحَمْدُ", "الرَّحْمَٰنِ"])

    assert len(filtered) == 1
    assert filtered[0].error_type == "madd"
    assert filtered[0].rule == "Madd"
    assert "Hold the vowel longer" in filtered[0].description_en


def test_postprocess_results_keeps_native_tajweed_rule() -> None:
    checker = MuaalemChecker.__new__(MuaalemChecker)
    results = [
        TajweedError(
            word_index=0,
            expected_phoneme="n",
            predicted_phoneme="n",
            error_type="tajweed",
            rule="Ikhfa",
            description_en="Ikhfa mismatch",
            description_ar="إخفاء",
            severity="medium",
            confidence=0.95,
        )
    ]

    filtered = checker._postprocess_results(results, ["أَنْبِئْهُمْ"])

    assert len(filtered) == 1
    assert filtered[0].error_type == "tajweed"
    assert filtered[0].rule == "Ikhfa"
    assert "Hide the noon or tanween softly" in filtered[0].description_en


def test_collapse_word_level_errors_keeps_single_best_error_per_word() -> None:
    errors = [
        TajweedError(
            word_index=0,
            expected_phoneme="aː",
            predicted_phoneme="a",
            error_type="madd",
            rule="Madd",
            description_en="Hold the vowel longer",
            description_ar="",
            severity="medium",
            confidence=0.70,
        ),
        TajweedError(
            word_index=0,
            expected_phoneme="sˤ",
            predicted_phoneme="s",
            error_type="tafkheem",
            rule="Tafkheem",
            description_en="This word needs a clearer heavy quality.",
            description_ar="",
            severity="high",
            confidence=0.90,
        ),
        TajweedError(
            word_index=1,
            expected_phoneme="n",
            predicted_phoneme="n",
            error_type="tajweed",
            rule="Ikhfa",
            description_en="Hide the noon softly.",
            description_ar="",
            severity="medium",
            confidence=0.95,
        ),
    ]

    collapsed = _collapse_word_level_errors(errors)

    assert len(collapsed) == 2
    assert collapsed[0].word_index == 0
    assert collapsed[0].error_type == "tafkheem"
    assert collapsed[1].word_index == 1
    assert collapsed[1].rule == "Ikhfa"
