"""Opt-in actual Chromium interactions; no mock browser or mocked HTTP responses.
Run LLM_ENGINE_BROWSER=1 ... pytest -s tests/test_web_browser.py.
"""
import json
import hashlib
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time

import httpx
import pytest

pytestmark = pytest.mark.skipif(os.environ.get('LLM_ENGINE_BROWSER') != '1', reason='opt-in browser validation: set LLM_ENGINE_BROWSER=1')


def test_installed_connections_shared_data(tmp_path, installed_package):
    """Real installed web -> explicit UI action -> real installed MCP, no mocks."""
    from playwright.sync_api import sync_playwright, expect

    python, runtime, env = installed_package
    evidence = Path(os.environ.get('LLM_ENGINE_BROWSER_EVIDENCE', str(tmp_path / 'evidence')))
    evidence.mkdir(parents=True, exist_ok=True)
    observations = []

    def digest(database):
        # Includes all persisted rows and schema, independent of SQLite page layout.
        with sqlite3.connect(database) as connection:
            return hashlib.sha256('\n'.join(connection.iterdump()).encode()).hexdigest()

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=os.environ.get('LLM_ENGINE_BROWSER_CHANNEL'))
        try:
            for populated in (False, True):
                label = 'populated' if populated else 'empty'
                database = tmp_path / f'{label}.sqlite3'
                subprocess.run([str(python), '-I', '-c',
                    'from llm_engine import _native; import sys; _native.list_agents(sys.argv[1])',
                    str(database)], cwd=runtime, env=env, check=True, capture_output=True)
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                url = f'http://127.0.0.1:{port}'
                executable = python.parent / ('agentown-web.exe' if os.name == 'nt' else 'agentown-web')
                with (evidence / f'shared-data-{label}-server.txt').open('w') as log:
                    server = subprocess.Popen([str(executable), '--database', str(database), '--port', str(port)],
                        cwd=runtime, env=env, stdout=log, stderr=subprocess.STDOUT)
                    page = browser.new_page()
                    try:
                        for _ in range(100):
                            try:
                                if httpx.get(url).status_code == 200:
                                    break
                            except httpx.HTTPError:
                                pass
                            assert server.poll() is None, 'Installed web exited'
                            time.sleep(.1)
                        else:
                            pytest.fail('Installed web startup timed out')
                        if populated:
                            headers = {'Origin': url}
                            employee = httpx.post(url + '/api/employees', json={'name': 'Shared reader'}, headers=headers)
                            assert employee.status_code == 201
                            work = httpx.post(url + '/api/work', json={'employee': employee.json()['id'], 'input': 'Private fixture work'}, headers=headers)
                            assert work.status_code == 201
                        before = digest(database)
                        requests = []
                        page.on('request', lambda request: requests.append(request.url) if '/api/connections/v1/shared-data' in request.url else None)
                        page.goto(url)
                        page.get_by_role('button', name='Open connections', exact=True).click()
                        section = page.get_by_role('region', name='Shared employee and work access')
                        expect(section.get_by_role('button', name='Check shared data', exact=True)).to_be_visible()
                        assert requests == []
                        with page.expect_response(url + '/api/connections/v1/shared-data') as response:
                            section.get_by_role('button', name='Check shared data', exact=True).click()
                        result = response.value.json()
                        count = int(populated)
                        assert result['status'] == 'passed' and result['code'] == 'shared_data_passed'
                        assert result['employee_count'] == count and result['work_count'] == count
                        expect(section).to_contain_text(f'Employees: {count}. Saved work: {count}.')
                        expect(section).to_contain_text('External client configuration remains unknown')
                        assert 'Private fixture work' not in section.inner_text()
                        assert len(requests) == 1
                        after = digest(database)
                        assert before == after
                        page.screenshot(path=str(evidence / f'shared-data-{label}.png'), full_page=True)
                        observations.append(dict(store=label, status=result['status'], employee_count=count,
                            work_count=count, database_unchanged=True, before_sha256=before, after_sha256=after))
                    finally:
                        page.close()
                        server.terminate()
                        try:
                            server.wait(timeout=15)
                        except subprocess.TimeoutExpired:
                            server.kill()
                            server.wait(timeout=5)
        finally:
            browser.close()
    (evidence / 'connections-shared-data.json').write_text(json.dumps(observations, indent=2))


def test_employee_to_result_browser(tmp_path, installed_package):
    python, runtime, env = installed_package
    profile = os.environ.get('LLM_ENGINE_BROWSER_PROFILE', 'full')
    assert profile in ('full', 'frontend'), f'Unknown browser profile: {profile}'
    from playwright.sync_api import sync_playwright, expect
    evidence = Path(os.environ.get('LLM_ENGINE_BROWSER_EVIDENCE', str(tmp_path / 'browser')))
    evidence.mkdir(parents=True, exist_ok=True)
    database = tmp_path / 'work.db'
    gate = tmp_path / 'provider-gate'
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    events = [{'step': 'verification-profile', 'profile': profile, 'process_recovery': profile == 'full'}]
    log = (evidence / 'server.txt').open('w')
    server = None

    def start():
        process = subprocess.Popen([str(python), '-I', str(runtime / 'server.py'), str(database), str(port), str(gate)], cwd=runtime, env=env, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if httpx.get(url + '/').status_code == 200:
                    return process
            except httpx.HTTPError:
                pass
            if process.poll() is not None:
                pytest.fail('browser fixture server failed; inspect server.txt')
            time.sleep(.1)
        process.kill()
        process.wait()
        pytest.fail('browser fixture did not start')

    def snapshot(page, name):
        page.screenshot(path=str(evidence / (name + '.png')), full_page=True)
        events.append({'step': name, 'status': page.locator('#connection').inner_text(),
                       'detail': page.locator('#detail').inner_text()})

    try:
        server = start()
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel=os.environ.get('LLM_ENGINE_BROWSER_CHANNEL'))
            context = browser.new_context(viewport={'width': 1200, 'height': 950}, reduced_motion='reduce')
            context.grant_permissions(['clipboard-read', 'clipboard-write'])
            context.tracing.start(screenshots=True, snapshots=True, sources=True)
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url)
            expect(page.locator('#root main')).to_have_count(1)
            assert page.locator('script[type=module][src^="/static/"]').count() == 1
            expect(page.locator('#connection')).to_contain_text('Connected')
            snapshot(page, '01-empty')
            page.keyboard.press('Tab')
            expect(page.get_by_role('link', name='Skip to workspace')).to_be_focused()
            page.get_by_label('Employee name').fill('<img src=x onerror="window.injected=true"> Writer')
            page.get_by_role('button', name='Create employee').evaluate('(b) => { b.click(); b.click(); }')
            expect(page.locator('#employees li')).to_have_count(1)
            expect(page.get_by_label('What would you like help with?')).to_be_focused()
            text = 'Summarize: We agreed to ship the draft on Friday. <script>window.injected=true</script>'
            page.get_by_label('What would you like help with?').fill(text)
            page.get_by_role('button', name='Save work').evaluate('(b) => { b.click(); b.click(); }')
            expect(page.locator('#detail .badge')).to_contain_text('Pending')
            expect(page.locator('#history option')).to_have_count(1)
            expect(page.get_by_role('button', name='Execute work')).to_be_focused()
            page.reload()
            expect(page.locator('#detail pre').first).to_have_text(text)
            snapshot(page, '02-pending-reloaded')
            execute = page.get_by_role('button', name='Execute work')
            # Reload starts a fresh Loop-authority inspection. Execution stays
            # disabled until that saved server state has been read, so exercise
            # the enabled control instead of racing the inspection request.
            expect(execute).to_be_enabled()
            execute.focus()
            page.keyboard.press('Enter')
            expect(page.locator('#detail .badge')).to_contain_text('Running')
            expect(page.get_by_role('button', name='Retry explicitly')).to_be_disabled()
            snapshot(page, '03-running')
            # Reload while provider I/O is outstanding. It must not resend.
            page.reload()
            expect(page.locator('#detail .badge')).to_contain_text('Running')
            gate.write_text('fail')
            expect(page.locator('#detail .badge')).to_contain_text('Failed')
            expect(page.locator('#detail')).to_contain_text('Wait for provider capacity')
            snapshot(page, '04-failure')
            gate.write_text('success')
            page.get_by_role('button', name='Retry explicitly').evaluate('(b) => { b.click(); b.click(); }')
            expect(page.locator('#detail .badge')).to_contain_text('Result available')
            expect(page.locator('#detail')).to_contain_text('END OF FULL RESULT')
            # Result rendering can precede the explicit persisted-history
            # confirmation that releases the submission lock. Wait for that
            # contract before testing graceful process shutdown, otherwise the
            # in-flight confirmation request is correctly treated by Uvicorn as
            # a background task and can outlive this test's shutdown deadline.
            expect(page.get_by_role('button', name='Retry explicitly')).to_be_enabled()
            assert page.evaluate('window.injected') is None
            assert page.locator('#detail script, #employees img').count() == 0
            snapshot(page, '05-result')
            original = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            assert len(original['work']) == 1 and len(original['employees']) == 1
            attempts = original['work'][0]['attempts']
            assert len(attempts) == 2 and attempts[0]['error'] == 'rate_limit'
            assert attempts[1]['quality'] == 'unverified'
            server.terminate()
            server.wait(timeout=15)
            expect(page.locator('#connection')).to_contain_text('Disconnected', timeout=10000)
            expect(page.get_by_role('button', name='Retry explicitly')).to_be_disabled()
            snapshot(page, '06-disconnected')
            server = start()
            page.get_by_role('button', name='Refresh connection').click()
            expect(page.locator('#connection')).to_contain_text('Connected')
            page.reload()
            expect(page.locator('#detail')).to_contain_text('END OF FULL RESULT')
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json() == original
            snapshot(page, '07-restarted-history')
            # Saved-result actions operate on the retained snapshot, even offline.
            result = attempts[1]
            actions = page.get_by_role('group', name='Attempt 2 result actions')
            copy = actions.get_by_role('button', name='Copy result')
            copy.focus()
            page.keyboard.press('Enter')
            expect(page.get_by_role('status').filter(has_text='Result copied.')).to_have_count(1)
            expect(copy).to_be_focused()
            assert page.evaluate('navigator.clipboard.readText()') == result['output']
            events.append({'step': 'restarted-copy', 'attempt': result['id'], 'exact_text': True, 'focus_retained': True})
            server.terminate()
            server.wait(timeout=15)
            expect(page.locator('#connection')).to_contain_text('Disconnected', timeout=10000)
            page.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: () => Promise.reject(new Error('denied'))}})")
            copy.focus()
            page.keyboard.press('Space')
            expect(page.get_by_role('status').filter(has_text='Could not copy.')).to_have_count(1)
            expect(copy).to_be_focused()
            page.keyboard.press('Tab')
            expect(actions.get_by_role('button', name='Download text')).to_be_focused()
            with page.expect_download() as download_info:
                page.keyboard.press('Enter')
            download = download_info.value
            assert download.suggested_filename == f"agentown-attempt-{result['id']}.txt"
            destination = evidence / download.suggested_filename
            download.save_as(destination)
            assert destination.read_bytes() == result['output'].encode('utf-8')
            events.append({'step': 'offline-download-after-restart', 'attempt': result['id'],
                           'filename': download.suggested_filename, 'bytes': destination.stat().st_size,
                           'clipboard_denial_reported': True})
            snapshot(page, '07-restarted-offline-download')
            server = start()
            page.get_by_role('button', name='Refresh connection').click()
            expect(page.locator('#connection')).to_contain_text('Connected')
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json() == original
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 2

            task = original['work'][0]['id']
            if profile == 'full':
                # Kill an actual process while its provider is waiting; never edit leases.
                gate.unlink()
                page.get_by_role('button', name='Retry explicitly').click()
                page.get_by_role('button', name='Confirm resend').click()
                expect(page.locator('#detail .badge')).to_contain_text('Running')
                snapshot(page, '08-outstanding-before-kill')
                # Running is persisted before SDK I/O starts. Wait for the provider
                # journal too, so the kill proves an outstanding submission.
                deadline = time.monotonic() + 10
                while len(gate.with_suffix('.calls').read_text().splitlines()) != 3:
                    assert time.monotonic() < deadline, 'Third provider submission did not start'
                    page.wait_for_timeout(50)
                server.kill()
                server.wait(timeout=15)
                events.append({'step': 'process-killed', 'pid': server.pid, 'returncode': server.returncode})
                assert server.returncode != 0
                server = start()
                page.reload()
                expect(page.locator('#detail summary').filter(has_text='interrupted')).to_have_count(1, timeout=135000)
                page.locator('#detail summary').filter(has_text='interrupted').click()
                expect(page.locator('#detail')).to_contain_text('No automatic resend occurred')
                snapshot(page, '08-interrupted-history')
            else:
                # UI-only changes still exercise the entire UI flow and three real
                # fixture submissions. Slow killed-process lease expiry belongs to
                # the full execution/storage/packaging gate, never shortened there.
                gate.write_text('success')
                page.get_by_role('button', name='Retry explicitly').click()
                page.get_by_role('button', name='Confirm resend').click()
                expect(page.locator('#detail .badge')).to_contain_text('Result available')
                assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
                # Match the full branch's fresh document, including removal of
                # the earlier clipboard-denial fixture before real paste checks.
                page.reload()
                expect(page.locator('#connection')).to_contain_text('Connected')
                events.append({'step': 'third-explicit-retry', 'process_recovery': 'not selected for frontend profile'})
                snapshot(page, '08-third-retry-history')
            recovered = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            assert recovered['work'][0]['attempts'][:2] == attempts
            assert len(recovered['work'][0]['attempts']) == 3
            historical_detail = page.locator(f'details[data-attempt-id="{result["id"]}"]')
            if historical_detail.get_attribute('open') is None:
                historical_detail.locator('summary').click()
            with page.expect_download() as historical_download:
                page.get_by_role('group', name='Attempt 2 result actions').get_by_role('button', name='Download text').click()
            historical_path = evidence / ('historical-' + historical_download.value.suggested_filename)
            historical_download.value.save_as(historical_path)
            assert historical_path.read_bytes() == result['output'].encode('utf-8')
            snapshot(page, '08-historical-download')

            # Reuse historical input offline; explicit save creates separate, unexecuted work.
            preserved_original = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()['work'][0]
            server.terminate()
            server.wait(timeout=15)
            expect(page.locator('#connection')).to_contain_text('Disconnected', timeout=10000)
            draft_action = page.get_by_role('button', name='Use as new draft')
            draft_action.focus()
            page.keyboard.press('Enter')
            editor = page.get_by_label('What would you like help with?')
            expect(editor).to_be_focused()
            expect(editor).to_have_value(text)
            revised = text + '\n  Revised request: 한글 😀 <b>literal markup</b>\n' + 'Long pasted request e\u0301 한글 😀. ' * 1500 + '\nKeep separate.  '
            # Real clipboard paste exercises browser insertion, including newline normalization.
            context.grant_permissions(['clipboard-read', 'clipboard-write'])
            editor.focus()
            page.keyboard.press('Meta+A' if os.sys.platform == 'darwin' else 'Control+A')
            clipboard_text = revised.replace('\n', '\r\n')
            page.evaluate('(text) => navigator.clipboard.writeText(text)', clipboard_text)
            page.keyboard.press('Meta+V' if os.sys.platform == 'darwin' else 'Control+V')
            expect(editor).to_have_value(revised)
            assert len(revised) > 25000 and len(revised.encode()) < 100000
            events.append({'step': 'real-long-paste', 'characters': len(revised), 'utf8_bytes': len(revised.encode()), 'newline_normalization': 'CRLF to LF'})
            draft_action.click()
            expect(page.get_by_role('button', name='Cancel')).to_be_focused()
            page.keyboard.press('Enter')
            expect(draft_action).to_be_focused()
            expect(editor).to_have_value(revised)
            expect(page.get_by_role('button', name='Save work')).to_be_disabled()
            snapshot(page, '08-revised-offline-draft')
            server = start()
            page.get_by_role('button', name='Refresh connection').click()
            expect(page.locator('#connection')).to_contain_text('Connected')
            expect(editor).to_have_value(revised)
            oversized = '"' * 60000
            editor.focus()
            page.keyboard.press('Meta+A' if os.sys.platform == 'darwin' else 'Control+A')
            page.evaluate('(text) => navigator.clipboard.writeText(text)', oversized)
            page.keyboard.press('Meta+V' if os.sys.platform == 'darwin' else 'Control+V')
            expect(editor).to_have_value(oversized)
            page.get_by_role('button', name='Save work').focus()
            page.keyboard.press('Enter')
            expect(editor).to_be_focused()
            expect(editor).to_have_attribute('aria-invalid', 'true')
            expect(page.locator('#input-error')).to_contain_text('120,000')
            expect(page.get_by_label('Assign to')).to_have_value(preserved_original['assignees'][0])
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()['work'] == [preserved_original]
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            snapshot(page, '08-oversized-paste-preserved')
            page.keyboard.press('Meta+A' if os.sys.platform == 'darwin' else 'Control+A')
            page.evaluate('(text) => navigator.clipboard.writeText(text)', revised)
            page.keyboard.press('Meta+V' if os.sys.platform == 'darwin' else 'Control+V')
            expect(editor).to_have_value(revised)
            expect(editor).to_have_attribute('aria-invalid', 'false')
            events.append({'step': 'oversized-paste-corrected', 'rejected_characters': len(oversized), 'submissions': 3, 'original_task': task, 'draft_preserved': True})
            unchanged = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            assert unchanged['work'] == [preserved_original]
            page.get_by_role('button', name='Save work').evaluate('(b) => { b.click(); b.click(); }')
            expect(page.locator('#history option')).to_have_count(2)
            expect(page.get_by_role('button', name='Execute work')).to_be_focused()
            saved = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            new_work = next(w for w in saved['work'] if w['id'] != task)
            assert new_work['input'] == revised and new_work['attempts'] == []
            assert new_work['assignees'] == preserved_original['assignees']
            assert next(w for w in saved['work'] if w['id'] == task) == preserved_original
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            snapshot(page, '08-separate-work-saved')
            server.terminate()
            server.wait(timeout=15)
            server = start()
            page.reload()
            expect(page.locator('#connection')).to_contain_text('Connected')
            restarted = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            assert restarted == saved
            native_saved = subprocess.run(
                [str(python), '-I', '-c',
                 'import json,sys; from llm_engine import _native; print(json.dumps(_native.show_task(sys.argv[1], sys.argv[2])))',
                 str(database), new_work['id']], cwd=runtime, env=env,
                text=True, capture_output=True, check=True)
            assert json.loads(native_saved.stdout)[1] == revised
            page.get_by_label('Saved work', exact=True).select_option(new_work['id'])
            expect(page.locator('#detail pre').first).to_have_text(revised)
            snapshot(page, '08-separate-work-restarted')
            page.get_by_label('Saved work', exact=True).select_option(task)
            expect(page.locator('#detail pre').first).to_have_text(text)
            expect(page.locator('#detail summary').filter(has_text='Attempt 2')).to_have_count(1)
            events.append({'step': 'revised-work-restarted', 'original_task': task,
                           'new_task': new_work['id'], 'original_input': text, 'revised_input': revised,
                           'original_unchanged': True, 'new_attempts': [], 'submissions': 3,
                           'offline_cancel_focus_preserved': True})
            snapshot(page, '08-original-preserved-after-revision')

            search = page.get_by_label('Search saved work')
            search.fill('REVISED REQUEST: 한글 😀 <b>literal markup</b>')
            expect(page.locator('#search-count')).to_have_text('1 of 2 saved requests match.')
            expect(page.locator('#selection-help')).to_contain_text('detail remains selected')
            assert page.locator('#detail pre').first.text_content() == text
            snapshot(page, '08-search-selected-original-excluded')
            page.get_by_label('Saved work', exact=True).select_option(new_work['id'])
            assert page.locator('#detail pre').first.text_content() == revised
            expect(page.locator('#detail summary')).to_have_count(0)
            snapshot(page, '08-search-revised-request')
            search.fill(text.upper())
            expect(page.locator('#search-count')).to_have_text('2 of 2 saved requests match.')
            page.get_by_label('Saved work', exact=True).select_option(task)
            assert page.locator('#detail pre').first.text_content() == text
            expect(page.locator('#detail summary').filter(has_text='Attempt 2')).to_have_count(1)
            search.fill('no matching saved request')
            expect(page.get_by_text('No saved work matches', exact=False)).to_be_visible()
            page.get_by_role('button', name='Clear search').focus()
            page.keyboard.press('Enter')
            expect(search).to_be_focused()
            expect(page.get_by_label('Saved work', exact=True)).to_have_value(task)
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json() == saved
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            events.append({'step': 'search-after-restart', 'original_task': task,
                           'revised_task': new_work['id'], 'original_input': text,
                           'revised_input': revised, 'exact_content': True,
                           'clear_focus': True, 'persisted_state_unchanged': True, 'submissions': 3})
            snapshot(page, '08-search-original-cleared')

            # Compare DOM timestamps with native records read by the installed wheel,
            # independently of the web API, after restart and process recovery.
            native = subprocess.run(
                [str(python), '-I', '-c',
                 'import json,sys; from llm_engine import _native; print(json.dumps(_native.list_runs(sys.argv[1], sys.argv[2])))',
                 str(database), task], cwd=runtime, env=env, text=True,
                capture_output=True, check=True)
            from datetime import datetime, timedelta, timezone
            epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
            recorded_times = []
            for run in json.loads(native.stdout):
                detail = page.locator(f'details[data-attempt-id="{run[0]}"]')
                if not detail.get_attribute('open') == '':
                    detail.locator('summary').click()
                expected = [(epoch + timedelta(milliseconds=value)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                            for value in (run[4], run[5])]
                expect(detail.locator('time')).to_have_count(2)
                for index, iso in enumerate(expected):
                    expect(detail.locator('time').nth(index)).to_have_attribute('datetime', iso)
                    expect(detail.locator('time').nth(index)).to_have_text(iso[:10] + ' ' + iso[11:23] + ' UTC')
                if run[7] == 'interruption':
                    expect(detail).to_contain_text('Interruption recorded:')
                    expect(detail).to_contain_text('not the precise process-stop time')
                recorded_times.append({'attempt': run[0], 'started': run[4], 'ended': run[5], 'datetime': expected})
            assert len(recorded_times) == 3
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json() == saved
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            events.append({'step': 'native-times-after-restart', 'task': task, 'attempts': recorded_times, 'submissions': 3})
            snapshot(page, '08-recorded-attempt-times')


            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            page.reload()
            expect(page.locator('#connection')).to_contain_text('Connected')
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            # Separate scenario and journal: preserve the original exactly-three contract.
            baseline = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            limited_input = 'Output-limit scenario: Explain the whole project. 한글 <b>literal</b>'
            editor.fill(limited_input)
            page.get_by_role('button', name='Save work', exact=True).click()
            expect(page.get_by_role('button', name='Execute work', exact=True)).to_be_focused()
            page.get_by_role('button', name='Execute work', exact=True).evaluate('(b) => { b.click(); b.click(); }')
            expect(page.locator('#detail .badge')).to_contain_text('Failed')
            expect(page.locator('#detail')).to_contain_text('partial response was not retained')
            expect(page.locator('#detail')).to_contain_text('Retry resends unchanged input and may hit the same limit')
            expect(page.get_by_role('button', name='Copy result')).to_have_count(0)
            limited_state = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            limited_work = next(w for w in limited_state['work'] if w['input'] == limited_input)
            limited_attempt, = limited_work['attempts']
            assert limited_attempt['error'] == 'output_limit' and limited_attempt['output'] is None
            assert limited_attempt['outcome'] == 'failure'
            assert limited_attempt['ended'] >= limited_attempt['started']
            assert len(gate.with_suffix('.limit-calls').read_text().splitlines()) == 1
            snapshot(page, '10-output-limit')
            page.get_by_role('button', name='Use as new draft').focus()
            page.keyboard.press('Enter')
            expect(editor).to_be_focused()
            expect(editor).to_have_value(limited_input)
            corrected_input = limited_input + '\nPlease answer in two sentences.'
            editor.fill(corrected_input)
            page.get_by_role('button', name='Save work', exact=True).click()
            expect(page.get_by_role('button', name='Execute work', exact=True)).to_be_focused()
            corrected_state = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            corrected_work = next(w for w in corrected_state['work'] if w['input'] == corrected_input)
            assert corrected_work['attempts'] == []
            assert corrected_work['assignees'] == limited_work['assignees']
            assert len(gate.with_suffix('.limit-calls').read_text().splitlines()) == 1
            page.get_by_role('button', name='Execute work', exact=True).click()
            expect(page.locator('#detail .badge')).to_contain_text('Result available')
            finished_limit = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            for old_work in baseline['work'] + [limited_work]:
                assert next(w for w in finished_limit['work'] if w['id'] == old_work['id']) == old_work
            server.terminate()
            server.wait(timeout=15)
            server = start()
            page.reload()
            expect(page.locator('#connection')).to_contain_text('Connected')
            assert httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json() == finished_limit
            page.get_by_label('Saved work', exact=True).select_option(limited_work['id'])
            expect(page.locator('#detail')).to_contain_text('partial response was not retained')
            assert page.locator('#detail pre').first.text_content() == limited_input
            from datetime import datetime, timezone
            for index, key in enumerate(('started', 'ended')):
                iso = datetime.fromtimestamp(limited_attempt[key] / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                expect(page.locator('#detail time').nth(index)).to_have_attribute('datetime', iso)
            native_limit = subprocess.run(
                [str(python), '-I', '-c',
                 'import json,sys; from llm_engine import _native; print(json.dumps([_native.show_execution(sys.argv[1],sys.argv[2]), _native.show_run(sys.argv[1],sys.argv[2])]))',
                 str(database), limited_attempt['id']], cwd=runtime, env=env,
                text=True, capture_output=True, check=True)
            native_execution, native_run = json.loads(native_limit.stdout)
            assert native_execution[1] == limited_input
            assert native_execution[5:] == [None, 'output_limit']
            assert native_run[4:6] == [limited_attempt['started'], limited_attempt['ended']]
            assert native_run[7] == 'failure'
            (evidence / 'output-limit-native.json').write_text(native_limit.stdout)
            snapshot(page, '11-output-limit-restarted')
            page.get_by_label('Saved work', exact=True).select_option(corrected_work['id'])
            assert page.locator('#detail pre').first.text_content() == corrected_input
            expect(page.locator('#detail')).to_contain_text('A shorter answer.')
            snapshot(page, '12-output-limit-corrected-restarted')
            assert len(gate.with_suffix('.limit-calls').read_text().splitlines()) == 2
            assert [json.loads(line) for line in gate.with_suffix('.limit-calls').read_text().splitlines()] == [
                {'input': limited_input, 'model': 'test-model'},
                {'input': corrected_input, 'model': 'test-model'},
            ]
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            (evidence / 'output-limit-provider-calls.txt').write_text(gate.with_suffix('.limit-calls').read_text())
            (evidence / 'output-limit-history.json').write_text(json.dumps(finished_limit, indent=2))
            events.append({'step': 'output-limit-correction-restart', 'limited_task': limited_work['id'],
                           'limited_run': limited_attempt['id'], 'corrected_task': corrected_work['id'],
                           'history': finished_limit, 'scenario_submissions': 2, 'original_submissions': 3})
            # Real installed UI: duplicate names must still navigate by employee ID.
            navigation_ids = []
            for index in range(2):
                page.get_by_label('Employee name').fill('Navigation Alex')
                page.get_by_role('button', name='Create employee', exact=True).click()
                expect(page.get_by_label('What would you like help with?')).to_be_focused()
                employee_id = page.get_by_label('Assign to', exact=True).input_value()
                page.get_by_label('What would you like help with?').fill(f'Navigation request {index}')
                page.get_by_role('button', name='Save work', exact=True).click()
                expect(page.get_by_role('button', name='Execute work', exact=True)).to_be_focused()
                navigation_ids.append((employee_id, page.get_by_label('Saved work', exact=True).input_value()))
            page.get_by_label('What would you like help with?').fill('Retain navigation draft')
            draft_assignment = page.get_by_label('Assign to', exact=True).input_value()
            navigation_requests = []
            def record_navigation(request):
                if request.method != 'GET' and '/api/' in request.url and not request.url.endswith('/api/state'):
                    navigation_requests.append(request.url)
            page.on('request', record_navigation)
            for index, (employee_id, work_id) in enumerate(navigation_ids):
                card = page.get_by_role('button', name=f'View assigned work: Navigation Alex · ID: {employee_id}', exact=True)
                card.focus()
                page.keyboard.press('Enter' if index == 0 else 'Space')
                expect(card).to_be_focused()
                expect(card).to_have_attribute('aria-pressed', 'true')
                expect(page.locator('#history option:not([value=""])')).to_have_count(1)
                page.get_by_role('button', name=f'Open request: Navigation request {index} · ID: {work_id}', exact=True).click()
                expect(page.get_by_label('Saved work', exact=True)).to_be_focused()
                expect(page.get_by_label('Saved work', exact=True)).to_have_value(work_id)
                page.get_by_role('button', name='Return to all employees', exact=True).click()
                expect(page.get_by_label('Search saved work', exact=True)).to_be_focused()
            context.set_offline(True)
            page.get_by_role('button', name='Refresh connection', exact=True).click()
            expect(page.locator('#connection')).to_contain_text('Disconnected')
            page.get_by_role('button', name=f'View assigned work: Navigation Alex · ID: {navigation_ids[0][0]}', exact=True).click()
            expect(page.get_by_text('Using stale assignments', exact=False)).to_be_visible()
            page.get_by_role('button', name='Show all loaded work', exact=True).click()
            expect(page.get_by_label('What would you like help with?')).to_have_value('Retain navigation draft')
            expect(page.get_by_label('Assign to', exact=True)).to_have_value(draft_assignment)
            assert navigation_requests == []
            snapshot(page, '13-employee-navigation-offline')
            context.set_offline(False)
            page.get_by_role('button', name='Refresh connection', exact=True).click()
            expect(page.locator('#connection')).to_contain_text('Connected')
            page.remove_listener('request', record_navigation)
            events.append({'step': 'employee-navigation', 'employee_work_ids': navigation_ids, 'navigation_mutations': navigation_requests})
            # Team changes never execute work; persisted IDs disambiguate names.
            page.get_by_role('button', name='Browse teams', exact=True).focus()
            page.keyboard.press('Enter')
            expect(page.get_by_text('Showing persisted teams.', exact=True)).to_be_visible()
            team_ids = []
            for index in range(2):
                page.get_by_label('Team name', exact=True).fill('Navigation team')
                page.get_by_role('button', name='Create team', exact=True).focus()
                page.keyboard.press('Enter')
                expect(page.get_by_label('Saved team', exact=True)).to_be_focused()
                team_ids.append(page.get_by_label('Saved team', exact=True).input_value())
            assert team_ids[0] != team_ids[1]
            page.get_by_label('Saved team', exact=True).select_option(team_ids[0])
            member_id, member_work_id = navigation_ids[1]
            member_checkbox = page.get_by_label(f'Navigation Alex · Employee ID: {member_id}', exact=True)
            member_checkbox.focus()
            page.keyboard.press('Space')
            page.get_by_label('Team name', exact=True).fill('Retained team draft')
            # Failed delivery retains both team and membership drafts, then recovers.
            page.route('**/api/teams/*/members', lambda route: route.abort())
            page.get_by_role('button', name='Add members', exact=True).click()
            expect(page.get_by_text('Showing stale team data.', exact=False)).to_be_visible()
            expect(member_checkbox).to_be_checked()
            expect(page.get_by_label('Team name', exact=True)).to_have_value('Retained team draft')
            page.unroute('**/api/teams/*/members')
            page.get_by_role('button', name='Refresh connection', exact=True).click()
            expect(page.locator('#connection')).to_contain_text('Connected')
            page.get_by_role('button', name='Refresh teams', exact=True).click()
            expect(page.get_by_text('Showing persisted teams.', exact=True)).to_be_visible()
            page.get_by_role('button', name='I inspected saved teams and membership', exact=True).click()
            expect(member_checkbox).to_be_checked()
            page.get_by_role('button', name='Add members', exact=True).click()
            expect(page.get_by_text(f'Membership saved · Team ID: {team_ids[0]}', exact=True)).to_be_visible()
            expect(page.get_by_label('Saved team', exact=True)).to_be_focused()
            team_baseline = httpx.get(url + '/api/teams').json()
            assert next(t for t in team_baseline['teams'] if t['id'] == team_ids[0])['members'] == [member_id]
            page.reload()
            expect(page.locator('#connection')).to_contain_text('Connected')
            page.get_by_role('button', name='Browse teams', exact=True).click()
            page.get_by_label('Saved team', exact=True).select_option(team_ids[0])
            member_button = page.get_by_role('button', name=f'View member work: Navigation Alex · ID: {member_id}', exact=True)
            expect(member_button).to_be_visible()
            team_navigation_requests = []
            def record_team_navigation(request):
                if request.method != 'GET' and '/api/' in request.url and not request.url.endswith('/api/state'):
                    team_navigation_requests.append(request.url)
            page.on('request', record_team_navigation)
            member_button.focus()
            page.keyboard.press('Enter')
            expect(page.get_by_label('Search saved work', exact=True)).to_be_focused()
            page.get_by_role('button', name=f'Open request: Navigation request 1 · ID: {member_work_id}', exact=True).click()
            expect(page.get_by_label('Saved work', exact=True)).to_have_value(member_work_id)
            expect(page.get_by_label('Saved work', exact=True)).to_be_focused()
            assert team_navigation_requests == []
            assert httpx.get(url + '/api/teams').json() == team_baseline
            assert len(gate.with_suffix('.calls').read_text().splitlines()) == 3
            page.remove_listener('request', record_team_navigation)
            (evidence / 'teams.json').write_text(json.dumps(team_baseline, indent=2))
            events.append({'step': 'teams-persisted-navigation', 'team_ids': team_ids,
                           'member_id': member_id, 'work_id': member_work_id,
                           'navigation_mutations': team_navigation_requests, 'submissions': 3})
            snapshot(page, '14-teams-persisted-navigation')
            page.set_viewport_size({'width': 390, 'height': 844})
            snapshot(page, '09-mobile')
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert not errors, errors
            persisted = httpx.post(url + '/api/state', json={}, headers={'Origin': url}).json()
            import shutil
            shutil.copy2(database, evidence / 'work.sqlite3')
            shutil.copy2(gate.with_suffix('.calls'), evidence / 'provider-calls.txt')
            (evidence / 'persisted.json').write_text(json.dumps(persisted, indent=2))
            context.tracing.stop(path=str(evidence / 'trace.zip'))
            browser.close()
    finally:
        if server is not None and server.poll() is None:
            server.terminate()
            server.wait(timeout=15)
        log.close()
        (evidence / 'interactions.json').write_text(json.dumps(events, indent=2))
    print(json.dumps({'browser': 'Chromium', 'steps': len(events), 'task': task, 'runs': [a['id'] for w in persisted['work'] if w['id'] == task for a in w['attempts']], 'evidence': str(evidence)}))
