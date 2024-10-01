import antfu from '@antfu/eslint-config'

export default antfu().append({ rules: { 'antfu/no-top-level-await': 'off' } })
