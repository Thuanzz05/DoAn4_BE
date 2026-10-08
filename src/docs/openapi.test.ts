import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { openApiDocument } from './openapi'

test('Swagger có đúng các route đang được mount và khai báo đầy đủ tham số đường dẫn', () => {
  const mounts = [
    ['index', 'apiRouter', ''], ['auth', 'authRouter', '/auth'],
    ['courses', 'coursesRouter', '/courses'], ['users', 'usersRouter', '/users'],
    ['academic', 'academicRouter', ''], ['admin-academic', 'adminAcademicRouter', ''], ['placement-assessments', 'placementAssessmentsRouter', ''], ['enrollment-import', 'enrollmentImportRouter', '/enrollments/import'],
    ['operations', 'operationsRouter', ''], ['overview', 'overviewRouter', ''],
    ['teacher', 'teacherRouter', '/teacher'], ['student', 'studentRouter', '/student'], ['ai', 'aiRouter', '/ai'],
  ]
  const implemented = new Set<string>()
  for (const [file, router, prefix] of mounts) {
    const source = readFileSync(join(__dirname, '..', 'routes', `${file}.ts`), 'utf8')
    const routes = new RegExp(`${router}\\.(get|post|patch|put|delete)\\(\\s*['\"]([^'\"]+)`, 'g')
    for (const match of source.matchAll(routes)) {
      const path = `${prefix}${match[2] === '/' ? '' : match[2]}`.replace(/:(\w+)/g, '{$1}')
      implemented.add(`${match[1]} ${path}`)
    }
  }
  const documented = new Set<string>()
  const operationIds = new Set<string>()
  for (const [path, operations] of Object.entries(openApiDocument.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      documented.add(`${method} ${path}`)
      assert.equal(operationIds.has(String(operation.operationId)), false, `operationId trùng: ${path}`)
      operationIds.add(String(operation.operationId))
      for (const match of path.matchAll(/\{(\w+)\}/g)) {
        const parameters = operation.parameters as Array<{ name: string; in: string; required: boolean }>
        assert.ok(parameters.some((parameter) => parameter.in === 'path' && parameter.name === match[1] && parameter.required))
      }
    }
  }
  assert.deepEqual(documented, implemented)
})

test('Swagger giữ Bearer JWT cho API nội bộ và không khai báo XLSX thành multipart', () => {
  assert.deepEqual(openApiDocument.security, [{ bearerAuth: [] }])
  assert.deepEqual(openApiDocument.paths['/auth/login'].post?.security, [])
  assert.equal(openApiDocument.paths['/classes'].get?.security, undefined)
  assert.equal(openApiDocument.paths['/teacher/sessions/{id}/attendance'].put?.security, undefined)
  assert.equal(openApiDocument.paths['/student/invoices'].get?.security, undefined)
  const body = openApiDocument.paths['/enrollments/import/preview'].post?.requestBody as { content: Record<string, unknown> }
  assert.deepEqual(Object.keys(body.content), ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
  function checkReferences(value: unknown): void {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref') {
        assert.ok(typeof item === 'string' && item.startsWith('#/'))
        let target: unknown = openApiDocument
        for (const part of item.slice(2).split('/')) {
          assert.ok(target && typeof target === 'object' && part in target, `Reference không tồn tại: ${item}`)
          target = (target as Record<string, unknown>)[part]
        }
      } else checkReferences(item)
    }
  }
  checkReferences(openApiDocument)
})
