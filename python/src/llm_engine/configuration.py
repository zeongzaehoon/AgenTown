"""Product configuration API. Enabled records are inert; Rust owns mutations.

All updates replace editable fields and preserve identity and enabled state.
ValueError means invalid input, KeyError a missing record/reference, and OSError
unavailable storage. No operation invokes execution or reads development files.
"""
from . import _native

_FIELDS = {
    'skill': {'name': str, 'instructions': str},
    'hook': {'name': str, 'skill_id': str, 'target_kind': str, 'target_id': str, 'event': str},
    'loop': {'name': str, 'task_id': str, 'max_iterations': int, 'interval_seconds': int},
}


def _call(kind, operation, database, id=None, /, **fields):
    expected = {'enabled': bool} if operation == 'set' else _FIELDS[kind]
    if operation in ('create', 'update', 'set'):
        if fields.keys() != expected.keys() or any(type(fields[k]) is not t for k, t in expected.items()):
            raise ValueError('Provide exactly the documented fields and types.')
    if operation in ('show', 'update', 'set') and type(id) is not str:
        raise ValueError('Provide a string identifier.')
    plural = {'skill': 'skills', 'hook': 'hooks', 'loop': 'loops'}[kind]
    name = f'list_{plural}' if operation == 'list' else f'set_{kind}_enabled' if operation == 'set' else f'{operation}_{kind}'
    args = [str(database)]
    if id is not None:
        args.append(id)
    if operation in ('create', 'update', 'set'):
        args.extend(fields[key] for key in expected)
    try:
        return getattr(_native, name)(*args)
    except OverflowError as exc:
        # PyO3 rejects integers outside Rust's u32 transport representation
        # before Core can validate policy limits. Keep the public error contract.
        raise ValueError('Configuration integer is outside the supported range.') from exc


def _adapters(kind):
    # Explicit operation boundaries; no arbitrary native method dispatch from HTTP.
    def create(database, **fields):
        return _call(kind, 'create', database, **fields)
    def update(database, id, **fields):
        return _call(kind, 'update', database, id, **fields)
    def show(database, id):
        return _call(kind, 'show', database, id)
    def listing(database):
        return _call(kind, 'list', database)
    def enabled(database, id, enabled):
        return _call(kind, 'set', database, id, enabled=enabled)
    return create, update, show, listing, enabled


create_skill, update_skill, show_skill, list_skills, set_skill_enabled = _adapters('skill')
create_hook, update_hook, show_hook, list_hooks, set_hook_enabled = _adapters('hook')
create_loop, update_loop, show_loop, list_loops, set_loop_enabled = _adapters('loop')


def routes(database, body, response):
    """Attach to the existing same-origin, bounded-body product server."""
    from starlette.routing import Route
    result = []
    for kind, plural in (('skill', 'skills'), ('hook', 'hooks'), ('loop', 'loops')):
        def handler_for(kind, plural):
            async def handler(request):
                try:
                    id = request.path_params.get('id')
                    if request.method == 'GET':
                        value = _call(kind, 'show' if id else 'list', database, id)
                        return response(value if id else {plural: value})
                    data = await body(request)
                    operation = 'set' if request.url.path.endswith('/enabled') else 'update' if id else 'create'
                    value = _call(kind, operation, database, id, **data)
                    return response(value, 201 if operation == 'create' else 200)
                except KeyError:
                    return response({'error': 'Configuration record or reference not found.'}, 404)
                except (ValueError, TypeError, OverflowError, UnicodeError):
                    return response({'error': 'Invalid configuration. Check the documented fields, types, limits and identifiers.'}, 400)
                except OSError:
                    return response({'error': 'Configuration storage unavailable. Check database access and compatibility.'}, 503)
            return handler
        handler = handler_for(kind, plural)
        path = f'/api/config/v1/{plural}'
        result.extend([Route(path, handler, methods=['GET', 'POST']),
                       Route(path + '/{id}', handler, methods=['GET', 'PUT']),
                       Route(path + '/{id}/enabled', handler, methods=['PUT'])])
    return result
