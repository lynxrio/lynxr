"""Offline synthetic eval regression; no live or paid dependencies required."""

import contextlib
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synthetic_eval as E


class SyntheticEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.suite, self.digest = E.load_suite()
        self.base = copy.deepcopy(self.suite['cases'][0])

    def checks(self, case=None):
        return {c['code']: c for c in E.evaluate(case or self.base)['checks']}

    def test_bundled_detector_expectations(self):
        report = E.build_report()
        self.assertEqual(report['expectation_mismatches'], [])
        self.assertEqual(len(report['cases']), 16)
        self.assertGreater(report['measurable_failures'], 0)
        self.assertEqual(report['evidence_type'], 'synthetic_fixture')
        self.assertTrue(all(case['provenance'] for case in report['cases']))

    def test_repeatable_and_does_not_mutate(self):
        original = copy.deepcopy(self.base)
        self.assertEqual(E.evaluate(self.base), E.evaluate(self.base))
        self.assertEqual(self.base, original)
        self.assertEqual(E.markdown(E.build_report()), E.markdown(E.build_report()))

    def test_word_budget_boundary_and_missing_policy(self):
        count = E.evaluate(self.base)['metrics']['spoken_words']
        self.base['conditions']['max_spoken_words'] = count
        self.assertEqual(self.checks()['length.words']['status'], 'pass')
        self.base['conditions']['max_spoken_words'] = count - 1
        self.assertEqual(self.checks()['length.words']['status'], 'fail')
        self.base['conditions'] = {}
        self.assertEqual(self.checks()['length.words']['status'], 'not_evaluable')

    def test_repeated_hook_and_unrelated_opening(self):
        self.assertEqual(self.checks()['hook.repetition']['status'], 'pass')
        self.base['adaptation']['beats'][0]['say'] = self.base['adaptation']['hook']
        self.assertEqual(self.checks()['hook.repetition']['status'], 'fail')
        self.base['adaptation']['hook'] = ''
        self.assertEqual(self.checks()['hook.repetition']['status'], 'not_evaluable')

    def test_missing_duration_is_not_a_pass(self):
        self.base['source'].pop('duration')
        self.assertEqual(self.checks()['timing.source_duration']['status'], 'not_evaluable')

    def test_nonfinite_bool_and_negative_duration_are_not_measured(self):
        for duration in (float('inf'), float('nan'), True, -1, 0, '10'):
            with self.subTest(duration=duration):
                self.base['source']['duration'] = duration
                self.assertEqual(self.checks()['timing.source_duration']['status'], 'not_evaluable')

    def test_timing_invalid_reversed_empty_and_zero_ranges(self):
        for value, status in [('4-0s', 'fail'), ('0-0s', 'fail'), ('NaN-3s', 'fail'),
                              ('0-Infinitys', 'fail'), ('-1-3s', 'fail'), ('', 'not_evaluable')]:
            with self.subTest(value=value):
                self.base['adaptation']['beats'][0]['t'] = value
                self.assertEqual(self.checks()['timing.beat_1']['status'], status)

    def test_timing_unicode_range_and_overrun_threshold(self):
        self.base['adaptation']['beats'][1]['t'] = '4 – 11.5 s'
        self.assertEqual(self.checks()['timing.source_duration']['status'], 'pass')
        self.base['adaptation']['beats'][1]['t'] = '4-11.51s'
        self.assertEqual(self.checks()['timing.source_duration']['status'], 'fail')

    def test_gaps_require_review_overlaps_fail(self):
        self.base['adaptation']['beats'][1]['t'] = '5-8s'
        self.assertEqual(self.checks()['timing.gap_2']['status'], 'review')
        self.base['adaptation']['beats'][1]['t'] = '3-8s'
        self.assertEqual(self.checks()['timing.order_2']['status'], 'fail')

    def test_format_counts_are_not_semantic_verdicts(self):
        self.base['format']['beats'].append({'role': 'invented extra role', 'seconds': 1})
        self.assertEqual(self.checks()['structure.alignment']['status'], 'review')
        self.assertEqual(self.checks()['structure.semantic_roles']['status'], 'review')
        self.base['format']['beats'][0]['seconds'] = float('inf')
        self.assertEqual(self.checks()['structure.format']['status'], 'fail')

    def test_malformed_fields_are_reported_without_shared_helper_crash(self):
        self.base['adaptation']['beats'] = ['broken']
        self.assertEqual(self.checks()['structure.beats']['status'], 'fail')
        self.base['adaptation'] = None
        self.assertEqual(self.checks()['structure.script']['status'], 'fail')
        self.base = copy.deepcopy(self.suite['cases'][0])
        self.base['adaptation']['beats'][0]['say'] = ['broken']
        self.assertEqual(self.checks()['structure.fields']['status'], 'fail')

    def test_source_delivery_missing_and_conflict_stay_distinct(self):
        self.base['source']['script'].pop('has_speech')
        self.assertEqual(self.checks()['structure.source_delivery']['status'], 'not_evaluable')
        self.base['source']['script']['has_speech'] = False
        self.assertEqual(self.checks()['structure.source_delivery']['status'], 'fail')

    def test_claim_mismatch_is_review_not_a_truth_failure(self):
        self.base['adaptation']['cta'] = 'Free shipping and 50% off at imaginary.example.com'
        checks = self.checks()
        self.assertEqual(checks['claims.token_support']['status'], 'review')
        self.assertEqual(checks['claims.truth']['status'], 'review')
        self.assertFalse(any(c['status'] == 'fail' for k, c in checks.items() if k.startswith('claims.')))
        self.base['brand']['description'] += ' Free shipping and 50% off at imaginary.example.com'
        self.assertEqual(self.checks()['claims.token_support']['status'], 'pass')
        self.assertEqual(self.checks()['claims.truth']['status'], 'review')
        self.base['brand'] = {}
        self.assertEqual(self.checks()['claims.reference']['status'], 'not_evaluable')

    def test_unrecognized_claims_still_require_human_review(self):
        self.base['adaptation']['cta'] = 'This guarantees a better life forever'
        self.assertEqual(self.checks()['claims.token_support']['status'], 'pass')
        self.assertEqual(self.checks()['claims.promise_language']['status'], 'review')
        self.assertEqual(self.checks()['claims.truth']['status'], 'review')

    def test_loader_rejects_unsourced_and_nonsynthetic_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.json'
            for key, value in [('evidence_type', 'measured'), ('provenance', '')]:
                suite = copy.deepcopy(self.suite)
                suite['cases'][0][key] = value
                path.write_text(json.dumps(suite))
                with patch.object(E, 'FIXTURES', path), self.assertRaises(ValueError):
                    E.load_suite()

    def test_report_sections_and_checked_in_snapshot_match(self):
        report = E.build_report()
        markdown = E.markdown(report)
        for section in ('Measurable failures', 'Human review required', 'Missing or unavailable conditions'):
            self.assertIn('## ' + section, markdown)
        saved = Path(__file__).parent.parent / 'docs/evaluation/synthetic-report.md'
        self.assertEqual(saved.read_text(), markdown)
        self.assertEqual(report['fixture_sha256'], self.digest)

    def test_detector_expectation_drift_exits_nonzero(self):
        changed = copy.deepcopy(self.suite)
        changed['cases'][0]['expected_failures'] = ['length.words']
        with patch.object(E, 'load_suite', return_value=(changed, self.digest)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(E.main(['--format', 'json']), 1)

    def test_cli_cannot_import_worker_load_credentials_or_use_network(self):
        script = Path(__file__).parent / 'eval_scripts.py'
        guard = '''import builtins, os, pathlib, runpy, socket, sys
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split('.')[0] in {'process_adaptations', 'envcfg', 'brain_prompt', 'hook_score', 'anthropic'}:
        raise AssertionError('forbidden production import: ' + name)
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
def blocked(*args, **kwargs):
    raise AssertionError('network, credential lookup or mkdir was attempted')
socket.socket.connect = blocked
socket.create_connection = blocked
os.getenv = blocked
pathlib.Path.mkdir = blocked
sys.argv = [sys.argv[1], 'synthetic', '--format', 'json']
runpy.run_path(sys.argv[0], run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, '-I', '-c', guard, str(script.resolve())],
                                    check=False, cwd=directory, env={'HOME': directory, 'PATH': os.defpath},
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), E.build_report())
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
