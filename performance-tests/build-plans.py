#!/usr/bin/env python3
"""
Generates the six JMeter test plans from one definition of the user journeys.

Why generated rather than six hand-maintained .jmx files: the journeys (which
endpoints, in what order, with what correlation) are identical across baseline /
load / peak / stress / spike / endurance. Only the thread schedule differs. Keeping
one definition means an endpoint change is edited once, not six times, and the plans
cannot silently drift apart.

The emitted .jmx files are ordinary JMeter 5.6 files. They open in the JMeter GUI and
run with `jmeter -n -t <plan>.jmx` with no dependency on this script.

    python3 build-plans.py            # writes jmeter/*.jmx
"""
import os
import xml.etree.ElementTree as ET
from xml.dom import minidom

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jmeter')

# --------------------------------------------------------------------------------
# Journeys. Each is a JMeter Thread Group; each step becomes a Transaction Controller
# so a "journey step" is measured as one figure regardless of how many requests it
# takes. `weight` is the share of virtual users given to that journey at a given
# total concurrency — see README §Workload model for how these were derived.
# --------------------------------------------------------------------------------
JOURNEYS = [
    {
        'name': 'A-HR-Admin',
        'weight': 0.06,
        'csv': 'hr_users',
        'think': (3000, 5000),
        'steps': [
            ('login',            [('POST', '/auth/login', 'LOGIN')]),
            ('exec-dashboard',   [('GET', '/reports/executive', None)]),
            ('hr-dashboard',     [('GET', '/reports/hr', None)]),
            ('cycle-list',       [('GET', '/appraisal/cycles', None)]),
            ('employee-search',  [('GET', '/organization/employees?page=1&pageSize=25&search=Perf', None)]),
            ('heatmap',          [('GET', '/reports/heatmap', None)]),
            ('institutional',    [('GET', '/reports/institutional', None)]),
            ('logout',           [('POST', '/auth/logout', None)]),
        ],
    },
    {
        'name': 'B-Manager',
        'weight': 0.14,
        'csv': 'mgr_users',
        'think': (3000, 6000),
        'steps': [
            ('login',          [('POST', '/auth/login', 'LOGIN')]),
            ('my-reviews',     [('GET', '/appraisal/my-reviews', None)]),
            ('my-team',        [('GET', '/reports/my-team', None)]),
            ('individual',     [('GET', '/reports/individual/${employeeId}', None)]),
            ('radar',          [('GET', '/reports/radar/${employeeId}', None)]),
            ('employee-360',   [('GET', '/reports/employee-360/${employeeId}', None)]),
            ('logout',         [('POST', '/auth/logout', None)]),
        ],
    },
    {
        'name': 'C-Employee-Feedback',
        'weight': 0.50,
        'csv': 'emp_users',
        'think': (4000, 9000),
        'steps': [
            ('login',        [('POST', '/auth/login', 'LOGIN')]),
            ('my-reviews',   [('GET', '/appraisal/my-reviews', 'ASSIGNMENT')]),
            ('open-form',    [('GET', '/appraisal/assignments/${assignmentId}/form', 'FORM')]),
            ('save-draft',   [('POST', '/appraisal/assignments/${assignmentId}/save', None)]),
            ('notifications',[('GET', '/notifications', None)]),
            ('logout',       [('POST', '/auth/logout', None)]),
        ],
    },
    {
        'name': 'D-Parent-Evaluation',
        'weight': 0.25,
        'csv': 'tokens',
        'think': (8000, 20000),   # a parent reads the form before answering
        'anonymous': True,
        'steps': [
            ('branding',   [('GET', '/public/branding', None)]),
            ('open-link',  [('GET', '/public/evaluate/${token}', None)]),
            # Submission is deliberately NOT in the default plan: a one-time link can
            # only be submitted once, so repeated submits measure 4xx handling rather
            # than the write path. Enable with -Jparent.submit=true after regenerating
            # single-use=false tokens. See README §Parent flow.
        ],
    },
    {
        'name': 'E-SIS-Browse',
        'weight': 0.05,
        'csv': 'hr_users',
        'think': (2000, 4000),
        'steps': [
            ('login',          [('POST', '/auth/login', 'LOGIN')]),
            ('sis-status',     [('GET', '/sis-integration/status', None)]),
            ('student-search', [('GET', '/sis/students?limit=25', None)]),
            ('student-detail', [('GET', '/sis/students/${studentId}', None)]),
            ('student-parents',[('GET', '/sis/students/${studentId}/parents', None)]),
            ('logout',         [('POST', '/auth/logout', None)]),
        ],
    },
]

# Thread schedules per test type. `mode` drives how threads are scheduled.
PLANS = {
    'baseline':  {'users': 5,   'ramp': 5,   'duration': 120,  'mode': 'steady',
                  'comment': 'One user per journey, minimal contention. Establishes uncontended per-endpoint latency; every other plan is read against this.'},
    'load':      {'users': 50,  'ramp': 60,  'duration': 600,  'mode': 'steady',
                  'comment': 'Expected production concurrency on an ordinary working day.'},
    'peak':      {'users': 150, 'ramp': 120, 'duration': 600,  'mode': 'steady',
                  'comment': 'Feedback-cycle opening / deadline day: everyone logs in at once and the parent burst lands.'},
    'spike':     {'users': 300, 'ramp': 1,   'duration': 300,  'mode': 'spike',
                  'comment': 'Step function 20 -> 100 -> 300 -> 600 with no ramp, modelling a WhatsApp/SMS send to every parent at once.'},
    'stress':    {'users': 400, 'ramp': 600, 'duration': 900,  'mode': 'ramp',
                  'comment': 'Continuous ramp past expected capacity until latency or error rate degrades. Finds the knee, not a pass/fail.'},
    'endurance': {'users': 60,  'ramp': 120, 'duration': 3600, 'mode': 'steady',
                  'comment': 'Sustained ordinary load for an hour to expose leaks: heap growth, connection-pool drift, Redis growth.'},
}


def el(parent, tag, **attrs):
    return ET.SubElement(parent, tag, {k.replace('_', ''): str(v) for k, v in attrs.items()})


def prop(parent, tag, name, value):
    e = ET.SubElement(parent, tag, {'name': name})
    e.text = str(value)
    return e


def bool_prop(parent, name, value):
    prop(parent, 'boolProp', name, 'true' if value else 'false')


def arguments(parent, name, pairs):
    """A JMeter Arguments collection (used for User Defined Variables)."""
    args = ET.SubElement(parent, 'Arguments', {
        'guiclass': 'ArgumentsPanel', 'testclass': 'Arguments', 'testname': name, 'enabled': 'true'})
    coll = ET.SubElement(args, 'collectionProp', {'name': 'Arguments.arguments'})
    for k, v in pairs:
        e = ET.SubElement(coll, 'elementProp', {'name': k, 'elementType': 'Argument'})
        prop(e, 'stringProp', 'Argument.name', k)
        prop(e, 'stringProp', 'Argument.value', v)
        prop(e, 'stringProp', 'Argument.metadata', '=')
    return args


def http_defaults(parent):
    c = ET.SubElement(parent, 'ConfigTestElement', {
        'guiclass': 'HttpDefaultsGui', 'testclass': 'ConfigTestElement',
        'testname': 'HTTP Request Defaults', 'enabled': 'true'})
    e = ET.SubElement(c, 'elementProp', {'name': 'HTTPsampler.Arguments', 'elementType': 'Arguments'})
    ET.SubElement(e, 'collectionProp', {'name': 'Arguments.arguments'})
    prop(c, 'stringProp', 'HTTPSampler.domain', '${__P(host,127.0.0.1)}')
    prop(c, 'stringProp', 'HTTPSampler.port', '${__P(port,3000)}')
    prop(c, 'stringProp', 'HTTPSampler.protocol', '${__P(protocol,http)}')
    prop(c, 'stringProp', 'HTTPSampler.path', '')
    prop(c, 'stringProp', 'HTTPSampler.connect_timeout', '${__P(connectTimeout,10000)}')
    prop(c, 'stringProp', 'HTTPSampler.response_timeout', '${__P(responseTimeout,60000)}')
    return c


def header_manager(parent, name, headers):
    h = ET.SubElement(parent, 'HeaderManager', {
        'guiclass': 'HeaderPanel', 'testclass': 'HeaderManager', 'testname': name, 'enabled': 'true'})
    coll = ET.SubElement(h, 'collectionProp', {'name': 'HeaderManager.headers'})
    for k, v in headers:
        e = ET.SubElement(coll, 'elementProp', {'name': '', 'elementType': 'Header'})
        prop(e, 'stringProp', 'Header.name', k)
        prop(e, 'stringProp', 'Header.value', v)
    return h


def csv_dataset(parent, name, filename, variables):
    c = ET.SubElement(parent, 'CSVDataSet', {
        'guiclass': 'TestBeanGUI', 'testclass': 'CSVDataSet', 'testname': name, 'enabled': 'true'})
    prop(c, 'stringProp', 'filename', filename)
    prop(c, 'stringProp', 'fileEncoding', 'UTF-8')
    prop(c, 'stringProp', 'variableNames', ','.join(variables))
    bool_prop(c, 'ignoreFirstLine', True)
    prop(c, 'stringProp', 'delimiter', ',')
    bool_prop(c, 'quotedData', False)
    bool_prop(c, 'recycle', True)          # loop the file rather than stopping the thread
    bool_prop(c, 'stopThread', False)
    prop(c, 'stringProp', 'shareMode', 'shareMode.all')
    return c


def thread_group(parent, name, threads, ramp, duration, delay=0):
    tg = ET.SubElement(parent, 'ThreadGroup', {
        'guiclass': 'ThreadGroupGui', 'testclass': 'ThreadGroup', 'testname': name, 'enabled': 'true'})
    prop(tg, 'stringProp', 'ThreadGroup.on_sample_error', 'continue')
    lc = ET.SubElement(tg, 'elementProp', {
        'name': 'ThreadGroup.main_controller', 'elementType': 'LoopController',
        'guiclass': 'LoopControlPanel', 'testclass': 'LoopController', 'testname': 'Loop', 'enabled': 'true'})
    bool_prop(lc, 'LoopController.continue_forever', False)
    prop(lc, 'stringProp', 'LoopController.loops', '-1')     # bounded by duration
    prop(tg, 'stringProp', 'ThreadGroup.num_threads', threads)
    prop(tg, 'stringProp', 'ThreadGroup.ramp_time', ramp)
    bool_prop(tg, 'ThreadGroup.scheduler', True)
    prop(tg, 'stringProp', 'ThreadGroup.duration', duration)
    prop(tg, 'stringProp', 'ThreadGroup.delay', delay)
    bool_prop(tg, 'ThreadGroup.same_user_on_next_iteration', False)
    return tg


def transaction(parent, name):
    t = ET.SubElement(parent, 'TransactionController', {
        'guiclass': 'TransactionControllerGui', 'testclass': 'TransactionController',
        'testname': name, 'enabled': 'true'})
    bool_prop(t, 'TransactionController.includeTimers', False)
    bool_prop(t, 'TransactionController.parent', True)
    return t


def sampler(parent, name, method, path, body=None):
    s = ET.SubElement(parent, 'HTTPSamplerProxy', {
        'guiclass': 'HttpTestSampleGui', 'testclass': 'HTTPSamplerProxy',
        'testname': name, 'enabled': 'true'})
    if body is not None:
        bool_prop(s, 'HTTPSampler.postBodyRaw', True)
        e = ET.SubElement(s, 'elementProp', {'name': 'HTTPsampler.Arguments', 'elementType': 'Arguments'})
        coll = ET.SubElement(e, 'collectionProp', {'name': 'Arguments.arguments'})
        a = ET.SubElement(coll, 'elementProp', {'name': '', 'elementType': 'HTTPArgument'})
        bool_prop(a, 'HTTPArgument.always_encode', False)
        prop(a, 'stringProp', 'Argument.value', body)
        prop(a, 'stringProp', 'Argument.metadata', '=')
    else:
        e = ET.SubElement(s, 'elementProp', {'name': 'HTTPsampler.Arguments', 'elementType': 'Arguments'})
        ET.SubElement(e, 'collectionProp', {'name': 'Arguments.arguments'})
    prop(s, 'stringProp', 'HTTPSampler.path', '${base}' + path)
    prop(s, 'stringProp', 'HTTPSampler.method', method)
    bool_prop(s, 'HTTPSampler.follow_redirects', True)
    bool_prop(s, 'HTTPSampler.auto_redirects', False)
    bool_prop(s, 'HTTPSampler.use_keepalive', True)
    bool_prop(s, 'HTTPSampler.DO_MULTIPART_POST', False)
    return s


def json_extractor(parent, name, variable, jsonpath, default='NOT_FOUND'):
    j = ET.SubElement(parent, 'JSONPostProcessor', {
        'guiclass': 'JSONPostProcessorGui', 'testclass': 'JSONPostProcessor',
        'testname': name, 'enabled': 'true'})
    prop(j, 'stringProp', 'JSONPostProcessor.referenceNames', variable)
    prop(j, 'stringProp', 'JSONPostProcessor.jsonPathExprs', jsonpath)
    prop(j, 'stringProp', 'JSONPostProcessor.match_numbers', '1')
    prop(j, 'stringProp', 'JSONPostProcessor.defaultValues', default)
    return j


def response_assertion(parent, name, codes=('200', '201')):
    a = ET.SubElement(parent, 'ResponseAssertion', {
        'guiclass': 'AssertionGui', 'testclass': 'ResponseAssertion',
        'testname': name, 'enabled': 'true'})
    coll = ET.SubElement(a, 'collectionProp', {'name': 'Asserion.test_strings'})
    for c in codes:
        p = ET.SubElement(coll, 'stringProp', {'name': str(hash(c) & 0xffffff)})
        p.text = c
    prop(a, 'stringProp', 'Assertion.test_field', 'Assertion.response_code')
    bool_prop(a, 'Assertion.assume_success', False)
    prop(a, 'intProp', 'Assertion.test_type', '33')   # equals, OR
    return a


def timer(parent, low, high):
    t = ET.SubElement(parent, 'UniformRandomTimer', {
        'guiclass': 'UniformRandomTimerGui', 'testclass': 'UniformRandomTimer',
        'testname': f'Think time {low}-{high}ms', 'enabled': 'true'})
    prop(t, 'stringProp', 'ConstantTimer.delay', low)
    prop(t, 'stringProp', 'RandomTimer.range', high - low)
    return t


def result_collector(parent, name, filename):
    r = ET.SubElement(parent, 'ResultCollector', {
        'guiclass': 'SummaryReport', 'testclass': 'ResultCollector',
        'testname': name, 'enabled': 'true'})
    bool_prop(r, 'ResultCollector.error_logging', False)
    obj = ET.SubElement(r, 'objProp')
    ET.SubElement(obj, 'name').text = 'saveConfig'
    v = ET.SubElement(obj, 'value', {'class': 'SampleSaveConfiguration'})
    for tag, val in [('time', 'true'), ('latency', 'true'), ('timestamp', 'true'), ('success', 'true'),
                     ('label', 'true'), ('code', 'true'), ('message', 'true'), ('threadName', 'true'),
                     ('dataType', 'false'), ('encoding', 'false'), ('assertions', 'true'),
                     ('subresults', 'false'), ('responseData', 'false'), ('samplerData', 'false'),
                     ('xml', 'false'), ('fieldNames', 'true'), ('responseHeaders', 'false'),
                     ('requestHeaders', 'false'), ('responseDataOnError', 'false'),
                     ('saveAssertionResultsFailureMessage', 'true'), ('bytes', 'true'),
                     ('sentBytes', 'true'), ('url', 'true'), ('threadCounts', 'true'),
                     ('idleTime', 'true'), ('connectTime', 'true')]:
        ET.SubElement(v, tag).text = val
    ET.SubElement(v, 'assertionsResultsToSave').text = '0'
    prop(r, 'stringProp', 'filename', filename)
    return r


LOGIN_BODY = '{"organizationSlug":"${orgSlug}","email":"${email}","password":"${password}"}'
SAVE_BODY = '{"responses":[{"questionId":"${questionId}","ratingValue":4}]}'
LOGOUT_BODY = '{"refreshToken":"${refreshToken}"}'


def build(plan_name, cfg):
    root = ET.Element('jmeterTestPlan', {'version': '1.2', 'properties': '5.0', 'jmeter': '5.6.3'})
    ht = ET.SubElement(root, 'hashTree')

    tp = ET.SubElement(ht, 'TestPlan', {
        'guiclass': 'TestPlanGui', 'testclass': 'TestPlan',
        'testname': f'Enterprise360 — {plan_name}', 'enabled': 'true'})
    prop(tp, 'stringProp', 'TestPlan.comments', cfg['comment'])
    bool_prop(tp, 'TestPlan.functional_mode', False)
    bool_prop(tp, 'TestPlan.serialize_threadgroups', False)
    e = ET.SubElement(tp, 'elementProp', {
        'name': 'TestPlan.user_defined_variables', 'elementType': 'Arguments',
        'guiclass': 'ArgumentsPanel', 'testclass': 'Arguments', 'testname': 'UDV', 'enabled': 'true'})
    ET.SubElement(e, 'collectionProp', {'name': 'Arguments.arguments'})
    tp_ht = ET.SubElement(ht, 'hashTree')

    # Everything environment-specific is a property with a safe default. No URL,
    # password or token is hard-coded anywhere in the plan.
    arguments(tp_ht, 'Environment', [
        ('base', '/api/v1'),
        ('dataDir', '${__P(dataDir,../data)}'),
        ('users', '${__P(users,%d)}' % cfg['users']),
        ('rampSeconds', '${__P(ramp,%d)}' % cfg['ramp']),
        ('durationSeconds', '${__P(duration,%d)}' % cfg['duration']),
    ])
    ET.SubElement(tp_ht, 'hashTree')

    http_defaults(tp_ht)
    ET.SubElement(tp_ht, 'hashTree')
    header_manager(tp_ht, 'Default headers', [('Content-Type', 'application/json'), ('Accept', 'application/json')])
    ET.SubElement(tp_ht, 'hashTree')

    csv_dataset(tp_ht, 'HR users', '${dataDir}/users_hr.csv', ['email', 'role', 'password', 'orgSlug'])
    ET.SubElement(tp_ht, 'hashTree')
    csv_dataset(tp_ht, 'Manager users', '${dataDir}/users_mgr.csv', ['mgrEmail', 'mgrRole', 'mgrPassword', 'mgrOrgSlug'])
    ET.SubElement(tp_ht, 'hashTree')
    csv_dataset(tp_ht, 'Employee users', '${dataDir}/users_emp.csv', ['empEmail', 'empRole', 'empPassword', 'empOrgSlug'])
    ET.SubElement(tp_ht, 'hashTree')
    csv_dataset(tp_ht, 'Employee ids', '${dataDir}/employees.csv', ['employeeId'])
    ET.SubElement(tp_ht, 'hashTree')
    csv_dataset(tp_ht, 'Student ids', '${dataDir}/students.csv', ['studentId'])
    ET.SubElement(tp_ht, 'hashTree')
    csv_dataset(tp_ht, 'Parent tokens', '${dataDir}/parent-tokens.csv', ['token', 'tokStudentId', 'tokTeacherId'])
    ET.SubElement(tp_ht, 'hashTree')

    for j in JOURNEYS:
        share = j['weight']
        if cfg['mode'] == 'spike':
            # Four stacked groups with staggered start: 20 -> 100 -> 300 -> 600.
            steps = [(20, 0), (100, 60), (300, 120), (600, 180)]
        else:
            steps = [(cfg['users'], 0)]

        for idx, (total, delay) in enumerate(steps):
            threads = max(1, round(total * share))
            if cfg['mode'] != 'spike':
                threads = max(1, round(cfg['users'] * share))
            suffix = f' step{idx+1}({total}u)' if cfg['mode'] == 'spike' else ''
            ramp = 1 if cfg['mode'] == 'spike' else '${__P(ramp,%d)}' % cfg['ramp']
            dur = 60 if cfg['mode'] == 'spike' else '${__P(duration,%d)}' % cfg['duration']
            # Thread count is resolved HERE, not in the plan: JEXL3 has no round() and
            # a failed expression silently yields a zero-thread group that runs nothing.
            # `users` in the .properties file scales the whole plan; per-journey shares
            # stay fixed so the workload mix is identical at every concurrency level.
            tg = thread_group(tp_ht, j['name'] + suffix, threads, ramp, dur, delay)
            tg_ht = ET.SubElement(tp_ht, 'hashTree')

            # Per-journey credential mapping: each journey reads its own CSV columns.
            if j['csv'] == 'mgr_users':
                arguments(tg_ht, 'Credentials', [('email', '${mgrEmail}'), ('password', '${mgrPassword}'), ('orgSlug', '${mgrOrgSlug}')])
                ET.SubElement(tg_ht, 'hashTree')
            elif j['csv'] == 'emp_users':
                arguments(tg_ht, 'Credentials', [('email', '${empEmail}'), ('password', '${empPassword}'), ('orgSlug', '${empOrgSlug}')])
                ET.SubElement(tg_ht, 'hashTree')

            if not j.get('anonymous'):
                header_manager(tg_ht, 'Bearer token', [('Authorization', 'Bearer ${accessToken}')])
                ET.SubElement(tg_ht, 'hashTree')

            for step_name, reqs in j['steps']:
                tc = transaction(tg_ht, f"{j['name']}:{step_name}")
                tc_ht = ET.SubElement(tg_ht, 'hashTree')
                for method, path, kind in reqs:
                    body = None
                    if kind == 'LOGIN':
                        body = LOGIN_BODY
                    elif path.endswith('/save'):
                        body = SAVE_BODY
                    elif path.endswith('/auth/logout'):
                        body = LOGOUT_BODY
                    s = sampler(tc_ht, f'{method} {path}', method, path, body)
                    s_ht = ET.SubElement(tc_ht, 'hashTree')
                    if kind == 'LOGIN':
                        json_extractor(s_ht, 'Extract accessToken', 'accessToken', '$.data.accessToken')
                        ET.SubElement(s_ht, 'hashTree')
                        json_extractor(s_ht, 'Extract refreshToken', 'refreshToken', '$.data.refreshToken')
                        ET.SubElement(s_ht, 'hashTree')
                    if kind == 'FORM':
                        json_extractor(s_ht, 'Extract questionId', 'questionId', '$.data.questions[0].id', '')
                        ET.SubElement(s_ht, 'hashTree')
                    if kind == 'ASSIGNMENT':
                        json_extractor(s_ht, 'Extract assignmentId', 'assignmentId', '$.data[0].id', '')
                        ET.SubElement(s_ht, 'hashTree')
                    response_assertion(s_ht, 'HTTP OK')
                    ET.SubElement(s_ht, 'hashTree')
                lo, hi = j['think']
                timer(tc_ht, lo, hi)
                ET.SubElement(tc_ht, 'hashTree')

    result_collector(tp_ht, 'Results', '${__P(resultsFile,../results/%s.jtl)}' % plan_name)
    ET.SubElement(tp_ht, 'hashTree')

    xml = minidom.parseString(ET.tostring(root, 'utf-8')).toprettyxml(indent='  ')
    xml = '\n'.join(l for l in xml.split('\n') if l.strip())
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'{plan_name}.jmx')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(xml + '\n')
    return path


if __name__ == '__main__':
    for name, cfg in PLANS.items():
        p = build(name, cfg)
        print(f'wrote {p}')
