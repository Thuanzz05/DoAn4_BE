type Schema = Record<string, unknown>
type Parameter = { name: string; in: 'query' | 'path'; required: boolean; schema: Schema }
type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'
type OperationOptions = {
  public?: boolean
  description?: string
  body?: Schema
  parameters?: Parameter[]
  status?: number
  response?: Schema
  binary?: boolean
  mimeTypes?: string[]
  upload?: boolean
}

const text = (example?: string): Schema => ({ type: 'string', ...(example === undefined ? {} : { example }) })
const id: Schema = { type: 'integer', minimum: 1, example: 1 }
const date: Schema = { type: 'string', format: 'date', example: '2026-10-12' }
const phone: Schema = { type: 'string', pattern: '^0\\d{9}$', example: '0901234567' }
const password: Schema = { type: 'string', format: 'password', minLength: 8 }
const time: Schema = { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$', example: '18:00' }
const enumeration = (...values: string[]): Schema => ({ type: 'string', enum: values })
const nullable = (schema: Schema): Schema => ({ ...schema, nullable: true })
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object', properties, ...(required.length ? { required } : {}),
})
const array = (items: Schema, minItems = 1): Schema => ({ type: 'array', items, minItems })
const query = (name: string, schema: Schema, required = false): Parameter => ({ name, in: 'query', required, schema })
const paths: Record<string, Partial<Record<Method, Record<string, unknown>>>> = {}
const roles: Record<string, string> = {
  'Người dùng': 'quan_tri', 'Khóa học': 'quan_tri', 'Phòng học': 'quan_tri',
  'Lớp học': 'quan_tri', 'Kỳ thi': 'quan_tri', 'Ghi danh': 'quan_tri', 'Lịch học': 'quan_tri',
  'Học phí': 'quan_tri', 'Chứng chỉ': 'quan_tri', 'Báo cáo': 'quan_tri',
  'Giáo viên': 'giao_vien', 'Học viên': 'hoc_vien',
}

function add(method: Method, path: string, tag: string, summary: string, options: OperationOptions = {}): void {
  const parameters: Parameter[] = [...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
    name: match[1], in: 'path', required: true, schema: match[1] === 'code' ? text() : id,
  }))
  parameters.push(...options.parameters ?? [])
  const status = options.status ?? 200
  const responses: Record<string, unknown> = {
    [status]: {
      description: status === 204 ? 'Đã xóa, không có nội dung trả về' : 'Thành công',
      ...(status === 204 ? {} : {
        content: options.binary
          ? Object.fromEntries((options.mimeTypes ?? ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']).map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]))
          : { 'application/json': { schema: options.response ?? { $ref: '#/components/schemas/Success' } } },
      }),
    },
    500: { $ref: '#/components/responses/ServerError' },
  }
  if (!options.public) {
    responses[401] = { $ref: '#/components/responses/Unauthorized' }
    responses[403] = { $ref: '#/components/responses/Forbidden' }
  }
  if (options.body || options.upload || parameters.some((parameter) => parameter.in === 'query')) {
    responses[400] = { $ref: '#/components/responses/BadRequest' }
  }
  if (method !== 'get') responses[409] = { $ref: '#/components/responses/Conflict' }
  if (parameters.some((parameter) => parameter.in === 'path')) responses[404] = { $ref: '#/components/responses/NotFound' }
  const role = !options.public ? roles[tag] : undefined
  paths[path] ??= {}
  paths[path][method] = {
    tags: [tag], summary,
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`,
    description: [role ? `Vai trò: ${role}.` : '', options.description ?? ''].filter(Boolean).join('\n\n'),
    ...(options.public ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(options.body || options.upload ? {
      requestBody: {
        required: true,
        content: options.upload
          ? { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } }
          : { 'application/json': { schema: options.body } },
      },
    } : {}),
    responses,
  }
}

const userFields = {
  fullName: text('Nguyễn Văn A'), email: { type: 'string', format: 'email' }, phone,
  birthDate: nullable(date), teachingLanguage: nullable(text('Tiếng Anh')), specialty: nullable(text()),
}
const userSchema = object({
  id, code: text(), ...userFields, role: enumeration('quan_tri', 'giao_vien', 'hoc_vien'),
  hasGoogle: { type: 'boolean' }, hasPassword: { type: 'boolean' },
})
const loginResponse = object({
  success: { type: 'boolean', example: true }, data: object({ token: text(), user: userSchema }, ['token', 'user']),
}, ['success', 'data'])

add('get', '/health', 'Hệ thống', 'Kiểm tra backend và MySQL', {
  public: true,
  response: object({ success: { type: 'boolean' }, message: text(), timestamp: { type: 'string', format: 'date-time' } }),
})
add('post', '/auth/login', 'Đăng nhập', 'Đăng nhập bằng email hoặc mã người dùng', {
  public: true,
  description: 'Nhập tài khoản hiện có. Sao chép data.token trong phản hồi, bấm Authorize và dán JWT (không thêm chữ Bearer).',
  body: object({ account: text('admin@gmail.com'), password }, ['account', 'password']), response: loginResponse,
})
add('post', '/auth/register', 'Đăng nhập', 'Đăng ký tài khoản học viên', {
  public: true, status: 201,
  body: object({ fullName: userFields.fullName, email: userFields.email, phone, birthDate: nullable(date), password }, ['fullName', 'email', 'phone', 'password']), response: loginResponse,
})
add('post', '/auth/google', 'Đăng nhập', 'Đăng nhập bằng Google ID token', {
  public: true, body: object({ credential: text() }, ['credential']), response: loginResponse,
  description: 'Cần GOOGLE_CLIENT_ID và ID token thật từ Google; không nhập access token.',
})
add('post', '/auth/google/link', 'Đăng nhập', 'Liên kết tài khoản Google', { body: object({ credential: text() }, ['credential']) })
add('delete', '/auth/google/link', 'Đăng nhập', 'Gỡ liên kết Google')
add('post', '/auth/forgot-password', 'Đăng nhập', 'Gửi OTP đặt lại mật khẩu', {
  public: true, body: object({ email: userFields.email }, ['email']),
  description: 'Thao tác gửi email thật nếu SMTP đã cấu hình. OTP có hạn 10 phút; development chưa có SMTP có thể trả devCode.',
})
add('post', '/auth/reset-password', 'Đăng nhập', 'Đặt lại mật khẩu bằng OTP', {
  public: true, body: object({ email: userFields.email, code: { type: 'string', pattern: '^\\d{6}$' }, newPassword: password }, ['email', 'code', 'newPassword']),
})
add('get', '/auth/me', 'Đăng nhập', 'Thông tin tài khoản đang đăng nhập')
add('patch', '/auth/me', 'Đăng nhập', 'Cập nhật hồ sơ cá nhân', { body: object({ fullName: userFields.fullName, phone: nullable(phone), birthDate: nullable(date) }) })
add('patch', '/auth/password', 'Đăng nhập', 'Đổi hoặc đặt mật khẩu', {
  body: object({ currentPassword: password, newPassword: password }, ['newPassword']),
  description: 'currentPassword bắt buộc nếu đã có mật khẩu. Thành công sẽ vô hiệu hóa JWT cũ; cần đăng nhập và Authorize lại.',
})
add('post', '/auth/logout', 'Đăng nhập', 'Đăng xuất và vô hiệu hóa các phiên hiện tại')

const courseFields = {
  code: text('TA-A1'), name: text('Tiếng Anh A1'), language: text('Tiếng Anh'), level: text('A1'),
  sessions: { ...id, example: 24 }, tuition: { type: 'integer', minimum: 1, example: 3000000 },
  description: nullable(text()), status: enumeration('dang_mo', 'tam_an'),
}
add('get', '/courses', 'Khóa học', 'Danh sách khóa học đang mở', { public: true })
add('get', '/courses/all', 'Khóa học', 'Danh sách toàn bộ khóa học')
add('get', '/courses/{id}', 'Khóa học', 'Chi tiết khóa học', { public: true })
add('post', '/courses', 'Khóa học', 'Tạo khóa học', { status: 201, body: object(courseFields, ['code', 'name', 'language', 'level', 'sessions', 'tuition']) })
add('patch', '/courses/{id}', 'Khóa học', 'Sửa khóa học', { body: object(courseFields) })
add('delete', '/courses/{id}', 'Khóa học', 'Xóa khóa chưa có dữ liệu liên quan', { status: 204 })

add('get', '/users', 'Người dùng', 'Danh sách người dùng', { parameters: [query('role', enumeration('quan_tri', 'giao_vien', 'hoc_vien'))] })
add('post', '/users', 'Người dùng', 'Tạo giáo viên hoặc học viên', {
  status: 201, body: object({ ...userFields, password, role: enumeration('giao_vien', 'hoc_vien') }, ['fullName', 'email', 'phone', 'role']),
  description: 'Bỏ trống password để sinh mật khẩu tạm. Gửi email sau khi tạo; nếu SMTP lỗi/chưa cấu hình, trả thông tin bàn giao và cảnh báo. Không trả mật khẩu khi email đã gửi thành công.',
})
add('patch', '/users/{id}', 'Người dùng', 'Cập nhật người dùng', { body: object(userFields) })
add('patch', '/users/{id}/status', 'Người dùng', 'Khóa hoặc mở tài khoản', {
  body: object({ active: { type: 'boolean' } }, ['active']), parameters: [query('force', { type: 'boolean', default: false })],
  description: 'Giáo viên đang có lớp cần xác nhận trước khi khóa. force=true bỏ qua bước xác nhận đó.',
})
add('post', '/users/{id}/reset-password', 'Người dùng', 'Cấp mật khẩu tạm cho người dùng', { description: 'Có thể gửi email thật và vô hiệu hóa phiên cũ. Không dùng API này chỉ để xem thử.' })
add('delete', '/users/{id}', 'Người dùng', 'Xóa người dùng chưa có dữ liệu nghiệp vụ', { status: 204 })

const roomFields = { code: text('P101'), capacity: { ...id, example: 30 } }
add('get', '/rooms', 'Phòng học', 'Danh sách phòng học')
add('post', '/rooms', 'Phòng học', 'Tạo phòng học', { status: 201, body: object(roomFields, ['code', 'capacity']) })
add('patch', '/rooms/{id}', 'Phòng học', 'Sửa phòng học', { body: object(roomFields) })
add('delete', '/rooms/{id}', 'Phòng học', 'Xóa phòng chưa được sử dụng', { status: 204 })

const classFields = {
  code: text('A1-T10'), name: text('Tiếng Anh A1 tháng 10'), courseId: id, teacherId: nullable(id),
  startDate: date, sessions: { ...id, example: 24 }, capacity: { ...id, example: 30 },
}
add('get', '/classes', 'Lớp học', 'Danh sách lớp học')
add('post', '/classes', 'Lớp học', 'Tạo lớp học', { status: 201, body: object(classFields, ['code', 'name', 'courseId', 'startDate', 'capacity']) })
add('patch', '/classes/{id}', 'Lớp học', 'Sửa lớp hoặc phân công giáo viên', { body: object(classFields), description: 'Không truyền status. Dùng các API bắt đầu/kết thúc/hủy lớp để chuyển trạng thái.' })
add('post', '/classes/{id}/start', 'Lớp học', 'Bắt đầu lớp', { description: 'Lớp sắp khai giảng, có giáo viên và đã sinh đủ buổi.' })
add('post', '/classes/{id}/complete', 'Lớp học', 'Kết thúc lớp', { description: 'Mọi buổi phải đã học. Các ghi danh đang học chuyển sang hoàn thành, chưa tự cấp chứng chỉ.' })
add('post', '/classes/{id}/cancel', 'Lớp học', 'Hủy lớp', { description: 'Phải xử lý chuyển lớp hoặc hủy ghi danh liên quan trước.' })
add('post', '/classes/{id}/generate-sessions', 'Lớp học', 'Sinh buổi theo lịch hàng tuần', { status: 201, description: 'Cần có giáo viên, lịch hàng tuần và chưa sinh buổi trước đó.' })
add('get', '/classes/{id}/sessions', 'Lớp học', 'Danh sách buổi học của lớp')
add('get', '/classes/{id}/academic', 'Lớp học', 'Hồ sơ học vụ: học viên, điểm danh còn thiếu và điểm toàn khóa')
add('get', '/classes/{id}/academic/export', 'Lớp học', 'Xuất Excel học vụ lớp', { binary: true, parameters: [query('section', enumeration('all', 'attendance', 'grades'))] })
const localDeadline = nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$', example: '2026-10-20T23:59', description: 'Giờ Việt Nam; không thêm Z.' })
const examFields = { classId: id, name: { type: 'string', minLength: 1, maxLength: 100 }, examDate: nullable(date), deadline: localDeadline, reason: { type: 'string', minLength: 1, maxLength: 255 } }
add('get', '/exams', 'Kỳ thi', 'Danh sách kỳ thi, hạn sửa và trạng thái khóa', { parameters: [query('classId', id)] })
add('post', '/exams', 'Kỳ thi', 'Quản trị viên tạo kỳ thi và lưu lịch sử', { status: 201, body: object(examFields, ['classId', 'name', 'reason']) })
add('patch', '/exams/{id}', 'Kỳ thi', 'Sửa thông tin hoặc gia hạn nhập điểm', { body: object(examFields, ['reason']), description: 'Bắt buộc lý do, lưu trước/sau/người sửa. Không đổi lớp, không xóa hạn đã đặt; hạn mới phải ở tương lai. Khóa khi lớp đã chốt chứng chỉ.' })
add('get', '/exams/{id}/history', 'Kỳ thi', 'Lịch sử tạo, sửa và gia hạn kỳ thi')
add('post', '/exams/{id}/cancel', 'Kỳ thi', 'Hủy kỳ thi nháp và giữ lịch sử', {
  body: object({ reason: { type: 'string', minLength: 1, maxLength: 255 } }, ['reason']),
  description: 'Chỉ kỳ thi chưa có kết quả và lớp chưa chốt chứng chỉ. Kỳ thi đã hủy không còn tính vào điểm toàn khóa hay điều kiện chứng chỉ; vẫn xem được lịch sử.',
})

add('get', '/enrollments', 'Ghi danh', 'Danh sách ghi danh')
add('post', '/enrollments', 'Ghi danh', 'Ghi danh khóa học và tự tạo hóa đơn', {
  status: 201, body: object({ studentId: id, courseId: id, classId: nullable(id), enrolledAt: date }, ['studentId', 'courseId']),
})
add('patch', '/enrollments/{id}', 'Ghi danh', 'Xếp/chuyển lớp hoặc đổi trạng thái ghi danh', {
  body: object({ classId: nullable(id), status: enumeration('cho_xep_lop', 'dang_hoc', 'bao_luu', 'hoan_thanh', 'da_huy') }),
  description: 'Trạng thái phải tuân theo vòng đời ghi danh; hoàn thành thông qua kết thúc lớp. Không chuyển lớp sau khi có điểm danh hoặc điểm thi.',
})
add('get', '/enrollments/import/template', 'Ghi danh', 'Tải Excel mẫu import học viên', { binary: true })
add('post', '/enrollments/import/preview', 'Ghi danh', 'Kiểm tra file Excel trước khi import', {
  upload: true, parameters: [query('courseId', id, true), query('classId', id)],
  description: 'Gửi nguyên tệp .xlsx tối đa 5 MB, không dùng multipart. Tối đa 100 học viên; cột Họ tên, Email, Số điện thoại và Ngày sinh (tùy chọn).',
})
add('post', '/enrollments/import/confirm', 'Ghi danh', 'Xác nhận import học viên, ghi danh và hóa đơn', {
  status: 201,
  body: object({ courseId: id, classId: nullable(id), rows: { ...array(object({ fullName: userFields.fullName, email: userFields.email, phone, birthDate: nullable(date) }, ['fullName', 'email', 'phone'])), maxItems: 100 } }, ['courseId', 'rows']),
  description: 'Tạo dữ liệu thật, kiểm tra lại toàn bộ dòng. Gửi thông tin đăng nhập cho tài khoản mới; chỉ trả mật khẩu bàn giao khi email chưa gửi được.',
})

const scheduleFields = { classId: id, roomId: id, dayOfWeek: { type: 'integer', minimum: 1, maximum: 7, example: 2, description: '1: Chủ nhật; 2: Thứ hai; …; 7: Thứ bảy.' }, startTime: time, endTime: { ...time, example: '19:30' } }
add('get', '/schedules', 'Lịch học', 'Danh sách lịch hàng tuần')
add('post', '/schedules', 'Lịch học', 'Tạo lịch hàng tuần', { status: 201, body: object(scheduleFields, Object.keys(scheduleFields)) })
add('patch', '/schedules/{id}', 'Lịch học', 'Sửa lịch hàng tuần', { body: object(scheduleFields) })
add('delete', '/schedules/{id}', 'Lịch học', 'Xóa lịch chưa sinh buổi', { status: 204 })
add('patch', '/sessions/{id}', 'Lịch học', 'Đổi buổi hoặc xếp lại buổi đã hủy', {
  body: object({ date, startTime: time, endTime: { ...time, example: '19:30' }, teacherId: id, roomId: id, reason: { type: 'string', minLength: 1, maxLength: 255 } }, ['date', 'startTime', 'endTime', 'teacherId', 'roomId', 'reason']),
  description: 'Ngày giờ mới phải ở tương lai; buổi đã bắt đầu không được sửa. Bắt buộc lý do, lưu lịch sử trước/sau.',
})
add('post', '/sessions/{id}/cancel', 'Lịch học', 'Hủy buổi học chưa có điểm danh', {
  body: object({ reason: { type: 'string', minLength: 1, maxLength: 255 } }, ['reason']),
  description: 'Cho xử lý buổi thực tế nghỉ nhưng quên hủy trước giờ. Chỉ lớp đang hoạt động, chưa chốt chứng chỉ và buổi chưa có điểm danh. Giữ buổi và lịch sử để xếp học bù.',
})
add('get', '/sessions/{id}/history', 'Lịch học', 'Lịch sử dời, hủy và bổ sung điểm danh')
add('get', '/sessions/{id}/attendance', 'Lịch học', 'Quản trị viên xem điểm danh để bổ sung dữ liệu còn thiếu')
add('put', '/sessions/{id}/attendance', 'Lịch học', 'Quản trị viên bổ sung điểm danh có lý do', {
  body: object({ reason: { type: 'string', minLength: 1, maxLength: 255 }, items: array(object({ enrollmentId: id, status: enumeration('co_mat', 'di_muon', 'vang'), note: nullable({ type: 'string', maxLength: 255 }) }, ['enrollmentId', 'status'])) }, ['reason', 'items']),
  description: 'Chỉ buổi đã bắt đầu, chưa hủy. Chỉ thêm bản ghi còn thiếu, không ghi đè điểm danh cũ hoặc thay giáo viên/phòng/giờ. Khóa dữ liệu đã chốt chứng chỉ, lưu người bổ sung và lịch sử.',
})

add('get', '/invoices', 'Học phí', 'Danh sách hóa đơn', {
  parameters: [query('query', text()), query('status', enumeration('chua_thanh_toan', 'da_thanh_toan', 'qua_han', 'da_huy')), query('classId', id), query('from', date), query('to', date)],
})
add('post', '/invoices', 'Học phí', 'Lập hóa đơn khi chưa có hóa đơn còn hiệu lực', {
  status: 201, body: object({ enrollmentId: id, dueDate: date, amount: { type: 'integer', minimum: 1 } }, ['enrollmentId', 'dueDate']),
})
add('patch', '/invoices/{id}/payment', 'Học phí', 'Xác nhận đã thu học phí', { body: object({ method: enumeration('tien_mat', 'chuyen_khoan') }, ['method']) })
add('patch', '/invoices/{id}/cancel', 'Học phí', 'Hủy hóa đơn chưa thanh toán', { body: object({ reason: text('Lập sai hóa đơn') }, ['reason']) })
add('post', '/invoices/reminders', 'Học phí', 'Nhắc hóa đơn trong 3 ngày tới hoặc quá hạn', { body: object({ classId: id }), description: 'Mỗi hóa đơn/hạn thanh toán chỉ nhắc một lần ở mỗi giai đoạn. Bỏ qua bảo lưu/hủy và tài khoản khóa; lưu thông báo trước khi thử email.' })

add('get', '/certificates/verify/{code}', 'Chứng chỉ', 'Xác thực công khai chứng chỉ', { public: true })
add('get', '/certificates/candidates', 'Chứng chỉ', 'Danh sách hồ sơ và điều kiện chứng chỉ')
add('post', '/certificates/approve', 'Chứng chỉ', 'Duyệt chứng chỉ cho các ghi danh', {
  status: 201, body: object({ enrollmentIds: array(id) }, ['enrollmentIds']),
  description: 'Đã hoàn thành, đủ học phí, chuyên cần ≥80%, đủ tất cả kỳ thi và trung bình ≥5. Duyệt xong sẽ khóa sửa điểm/điểm danh.',
})
add('patch', '/certificates/{id}/issue', 'Chứng chỉ', 'Tạo PDF và phát hành chứng chỉ đã duyệt')
add('post', '/certificates/{id}/reissue', 'Chứng chỉ', 'Tạo lại PDF chứng chỉ', { description: 'Giữ nguyên nội dung đã chốt, số chứng chỉ, mã xác thực và ngày cấp gốc; không phải đính chính.' })
add('patch', '/certificates/{id}/details', 'Chứng chỉ', 'Đính chính thông tin trước khi phát hành', {
  body: object({ studentCode: text(), studentName: text(), courseName: text(), language: text(), classCode: text(), className: text(), reason: { type: 'string', minLength: 1, maxLength: 255 } }, ['studentCode', 'studentName', 'courseName', 'language', 'classCode', 'className', 'reason']),
  description: 'Chỉ hồ sơ đã duyệt nhưng chưa phát hành. Lưu dấu vết trước/sau và lý do; không thay điểm, chuyên cần hoặc học phí đã chốt.',
})
add('get', '/reports', 'Báo cáo', 'Báo cáo học phí và đào tạo', {
  parameters: [query('period', enumeration('month', 'quarter', 'year')), query('year', { type: 'integer', minimum: 2000, maximum: 2100, example: 2026 }), query('unit', { type: 'integer', minimum: 1, maximum: 12, description: 'Tháng 1–12 hoặc quý 1–4; bỏ qua khi period=year.' })],
})
add('get', '/certificates/{id}/corrections', 'Chứng chỉ', 'Lịch sử đính chính, người sửa và dữ liệu trước/sau')
add('get', '/reports/export', 'Báo cáo', 'Xuất báo cáo đầy đủ Excel hoặc PDF', {
  binary: true, mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf'], parameters: [query('period', enumeration('month', 'quarter', 'year')), query('year', { type: 'integer', minimum: 2000, maximum: 2100 }), query('unit', { type: 'integer', minimum: 1, maximum: 12 }), query('format', enumeration('xlsx', 'pdf'))],
  description: 'XLSX gồm 5 sheet; PDF gồm tổng quan, doanh thu, ngoại ngữ, khóa học và kết quả theo lớp.',
})
add('get', '/admin/dashboard', 'Báo cáo', 'Dashboard quản trị viên')

add('get', '/notifications', 'Thông báo', 'Thông báo của tài khoản hiện tại', { parameters: [query('unreadOnly', { type: 'boolean', default: false }), query('paginated', { type: 'boolean', default: false }), query('page', id), query('pageSize', { type: 'integer', minimum: 1, maximum: 100 })], description: 'paginated=true trả data.items và data.pagination (total, unread). Mặc định giữ danh sách 50 thông báo gần nhất.' })
add('patch', '/notifications/read-all', 'Thông báo', 'Đánh dấu thông báo đã đọc', { body: object({ ids: { type: 'array', items: id, maxItems: 100 } }), description: 'Có ids: chỉ đọc thông báo của tài khoản trong danh sách. Bỏ ids: đọc toàn bộ.' })
add('patch', '/notifications/{id}/read', 'Thông báo', 'Đánh dấu một thông báo đã đọc')
add('post', '/notifications', 'Thông báo', 'Quản trị viên gửi thông báo', {
  status: 201, description: 'Vai trò quan_tri. Chọn đúng một đối tượng: userId hoặc role.',
  body: { ...object({ title: text(), content: text(), userId: id, role: enumeration('quan_tri', 'giao_vien', 'hoc_vien') }, ['title', 'content']), example: { title: 'Thông báo lớp học', content: 'Vui lòng kiểm tra lịch học mới.', userId: 1 }, oneOf: [{ required: ['userId'], not: { required: ['role'] } }, { required: ['role'], not: { required: ['userId'] } }] },
})

const dateRange = [query('from', date), query('to', date)]
add('get', '/teacher/dashboard', 'Giáo viên', 'Dashboard giáo viên')
add('get', '/teacher/classes', 'Giáo viên', 'Lớp giáo viên đang phụ trách')
add('get', '/teacher/sessions', 'Giáo viên', 'Lịch dạy theo buổi thực tế', { parameters: dateRange })
add('get', '/teacher/sessions/{id}/attendance', 'Giáo viên', 'Danh sách điểm danh của buổi')
add('put', '/teacher/sessions/{id}/attendance', 'Giáo viên', 'Lưu điểm danh cả lớp', {
  body: object({ items: array(object({ enrollmentId: id, status: enumeration('co_mat', 'di_muon', 'vang'), note: nullable(text()) }, ['enrollmentId', 'status'])) }, ['items']),
  description: 'Cần đúng giáo viên của buổi, đã đến giờ bắt đầu, buổi không hủy. Gửi đủ danh sách, không trùng học viên. Hồ sơ đã duyệt chứng chỉ không được thay đổi.',
})
add('get', '/teacher/classes/{id}/exams', 'Giáo viên', 'Danh sách kỳ thi của lớp')
add('get', '/teacher/classes/{id}/academic', 'Giáo viên', 'Thống kê chuyên cần, thiếu điểm danh và điểm toàn khóa')
add('get', '/teacher/classes/{id}/academic/export', 'Giáo viên', 'Xuất Excel thống kê lớp phụ trách', { binary: true, parameters: [query('section', enumeration('all', 'attendance', 'grades'))] })
add('post', '/teacher/classes/{id}/exams', 'Giáo viên', 'Tạo kỳ thi', {
  status: 201,
  body: object({ name: text('Kiểm tra cuối khóa'), examDate: nullable(date), deadline: nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$', example: '2026-10-20T23:59', description: 'Giờ địa phương Việt Nam, không thêm Z hoặc múi giờ.' }) }, ['name']),
})
add('get', '/teacher/exams/{id}/results', 'Giáo viên', 'Bảng điểm toàn lớp và lý do chặn học viên chưa đủ học phí')
const score: Schema = { type: 'number', nullable: true, minimum: 0, maximum: 10, example: 7.5 }
add('put', '/teacher/exams/{id}/results', 'Giáo viên', 'Lưu điểm bốn kỹ năng', {
  body: object({ items: array(object({ enrollmentId: id, listening: score, speaking: score, reading: score, writing: score }, ['enrollmentId', 'listening', 'speaking', 'reading', 'writing'])) }, ['items']),
  description: 'Cho lưu bản nháp: kỹ năng chưa nhập gửi null, điểm 0 là điểm thật. Chỉ đủ bốn điểm 0–10 mới hoàn thành kỳ thi. Không trùng ghi danh; chỉ học viên đã hoàn tất học phí, không lưu quá hạn hoặc sửa hồ sơ đã duyệt chứng chỉ.',
})

add('get', '/student/dashboard', 'Học viên', 'Dashboard học viên')
add('get', '/student/classes', 'Học viên', 'Các lớp và ghi danh của mình')
add('get', '/student/sessions', 'Học viên', 'Lịch học của mình', { parameters: dateRange })
add('get', '/student/results', 'Học viên', 'Điểm thi và lịch sử điểm danh')
add('get', '/student/invoices', 'Học viên', 'Hóa đơn học phí của mình')
add('get', '/student/certificates', 'Học viên', 'Chứng chỉ của mình')
add('get', '/student/certificate-downloads', 'Học viên', 'Lịch sử yêu cầu tải chứng chỉ')
add('get', '/student/certificate-eligibility', 'Học viên', 'Điều kiện và lý do chưa đạt chứng chỉ')
add('post', '/student/certificates/{id}/download', 'Học viên', 'Ghi nhận yêu cầu tải PDF chứng chỉ', { status: 201, description: 'Trả JSON gồm pdfPath và mã xác thực, không trả trực tiếp nội dung PDF.' })
add('post', '/ai/tu-van-khoa-hoc', 'AI tư vấn', 'Tư vấn khóa học đang mở', {
  public: true, body: object({ question: { type: 'string', minLength: 5, maxLength: 1000, example: 'Tôi mới bắt đầu học tiếng Anh, nên chọn khóa nào?' } }, ['question']),
  description: 'Cần cấu hình GEMINI_API_KEY. Nội dung gửi tới dịch vụ AI; tối đa 20 yêu cầu/15 phút.',
})

const errorSchema = { $ref: '#/components/schemas/Error' }
export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Đồ án 4 — API trung tâm ngoại ngữ', version: '1.0.0',
    description: '1. Mở POST /auth/login → Try it out → nhập tài khoản và mật khẩu thật → Execute.\n2. Sao chép data.token → Authorize → dán JWT, không thêm Bearer.\n3. Thử GET /auth/me, sau đó chọn API theo vai trò.\n\nCác lệnh tạo/sửa/xóa, gửi email và xác nhận học phí tác động dữ liệu thật. ID trong ví dụ chỉ minh họa; thay bằng ID lấy từ API danh sách. Tài liệu dùng JWT của bạn, không bỏ qua phân quyền.',
  },
  servers: [{ url: '/api', description: 'Backend đang mở — cùng máy chủ với Swagger' }],
  security: [{ bearerAuth: [] }],
  tags: ['Hệ thống', 'Đăng nhập', 'Khóa học', 'Người dùng', 'Phòng học', 'Lớp học', 'Kỳ thi', 'Ghi danh', 'Lịch học', 'Học phí', 'Chứng chỉ', 'Báo cáo', 'Thông báo', 'Giáo viên', 'Học viên', 'AI tư vấn'].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Dán data.token từ API đăng nhập; không thêm chữ Bearer.' } },
    schemas: {
      Success: object({ success: { type: 'boolean', example: true }, data: {}, message: text() }, ['success']),
      Error: object({ success: { type: 'boolean', example: false }, message: text('Thông báo lỗi'), code: text() }, ['success', 'message']),
    },
    responses: Object.fromEntries([
      ['BadRequest', 'Dữ liệu không hợp lệ'], ['Unauthorized', 'Chưa đăng nhập hoặc JWT hết hiệu lực'],
      ['Forbidden', 'Không đúng vai trò hoặc tài khoản bị khóa'], ['NotFound', 'Không tìm thấy dữ liệu'],
      ['Conflict', 'Xung đột dữ liệu hoặc không thỏa điều kiện nghiệp vụ'], ['ServerError', 'Lỗi máy chủ'],
    ].map(([name, description]) => [name, { description, content: { 'application/json': { schema: errorSchema } } }])),
  },
}
